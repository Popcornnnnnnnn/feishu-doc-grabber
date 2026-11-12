import { validateDocumentURL } from './exporter.mjs';
import { readSourceTab, abortSourceRequests, readBitableTables } from './browser-transport.mjs';
import { captureBoard } from './board-capture.mjs';
import { normalizeSettings } from './settings.mjs';

function isDocument(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /\.(feishu\.cn|larkoffice\.com|larksuite\.com)$/.test(parsed.hostname)
      && /^\/(docx|wiki|base)\/[A-Za-z0-9]+/.test(parsed.pathname);
  } catch { return false; }
}
let exportState = null;
async function updateAction(tab) {
  if (tab.id === undefined) return;
  const url = tab.pendingUrl || tab.url;
  let matches = false;
  try { matches = tab.id === exportState?.source.id && validateDocumentURL(url).href === exportState.source.url; }
  catch { /* Unsupported pages never inherit an export badge. */ }
  const state = matches ? exportState : null;
  const running = ['running', 'saving'].includes(state?.status);
  const ok = state?.status === 'complete' && state.result?.report.documents[0].integrity.verdict === 'complete';
  const text = !state || state.status === 'cancelled' ? '' : running ? '…' : ok ? '✓' : '!';
  await Promise.all([
    isDocument(url) ? chrome.action.enable(tab.id) : chrome.action.disable(tab.id),
    chrome.action.setBadgeText({ tabId: tab.id, text }),
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: running ? '#3269ed' : ok ? '#187546' : '#966012' }),
  ]);
}
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.url || change.status) updateAction(tab).catch(() => {});
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(updateAction).catch(() => {});
});

const offscreenURL = chrome.runtime.getURL('extension/offscreen.html');
const popupURL = chrome.runtime.getURL('extension/task.html');
let creating;
async function hasExportWorker() {
  return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenURL] })).length > 0;
}
async function ensureExportWorker() {
  if (creating) return creating;
  if (await hasExportWorker()) return;
  if (creating) return creating;
  creating = chrome.offscreen.createDocument({
    url: 'extension/offscreen.html', reasons: ['WORKERS', 'BLOBS'],
    justification: 'Generate the export ZIP in a worker and retain its download Blob after the popup closes.',
  });
  try { await creating; } finally { creating = null; }
}
const sendWorker = (command, data = {}) => chrome.runtime.sendMessage({ target: 'export-worker', command, ...data });
async function handleCommand(message, sender) {
  const fromWorker = sender.url === offscreenURL;
  const fromPopup = sender.url?.split('#')[0] === popupURL;
  if (sender.id !== chrome.runtime.id || (!fromWorker && !fromPopup)) throw new Error('Unsupported export request.');
  if (fromWorker) {
    switch (message.command) {
      case 'read': return readSourceTab(message.tabId, message.origin, message.url, message.options, message.requestId);
      case 'abort': await abortSourceRequests(message.tabId, message.ids).catch(() => {}); return null;
      case 'capture': return captureBoard({ tabId: message.tabId, blockId: message.board.blockId, index: message.board.index || 0 });
      case 'bitable-tables': return readBitableTables(message.tabId);
      case 'download': {
        if (!message.url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)) throw new Error('Invalid archive address.');
        const id = await chrome.downloads.download({ url: message.url, filename: message.filename, conflictAction: 'uniquify', saveAs: message.saveAs === true });
        return { id };
      }
      case 'download-status': {
        const [item] = await chrome.downloads.search({ id: message.id });
        return item?.state;
      }
      case 'cancel-download': await chrome.downloads.cancel(message.id); return null;
      default: throw new Error('Unknown background operation.');
    }
  }
  if (message.command === 'settings-get') return { settings: normalizeSettings((await chrome.storage.local.get('settings')).settings) };
  if (message.command === 'settings-save') {
    const settings = normalizeSettings(message.settings);
    await chrome.storage.local.set({ settings });
    return { settings };
  }
  if (message.command === 'start') {
    let tab;
    try { tab = await chrome.tabs.get(message.source.id); }
    catch { throw new Error('The source tab was closed. Open the document and click the extension icon again.'); }
    const url = validateDocumentURL(tab.url).href;
    if (url !== validateDocumentURL(message.source.url).href) throw new Error('The source tab is showing a different document. Reopen the popup to export it.');
    await ensureExportWorker();
    const settings = normalizeSettings((await chrome.storage.local.get('settings')).settings);
    return sendWorker('start', { source: { id: tab.id, url, title: tab.title || 'Feishu document' }, settings });
  }
  if (['snapshot', 'cancel', 'download-again'].includes(message.command)) {
    if (!await hasExportWorker()) return { state: null };
    return sendWorker(message.command);
  }
  throw new Error('Unknown export command.');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target === 'export-state' && sender.id === chrome.runtime.id && sender.url === offscreenURL) {
    const previousTabId = exportState?.source.id;
    exportState = message.state;
    // Only the source tab may display this job's status. Reading the tab again
    // also prevents late progress/completion messages from marking a new page.
    for (const tabId of new Set([previousTabId, exportState?.source.id])) {
      if (tabId !== undefined) chrome.tabs.get(tabId).then(updateAction).catch(() => {});
    }
    return;
  }
  if (message.target !== 'export-service') return;
  handleCommand(message, sender).then((value) => respond({ value }), (error) => respond({ error: error.message }));
  return true;
});
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && ['complete', 'interrupted'].includes(delta.state.current)) {
    hasExportWorker().then((exists) => exists && sendWorker('download-state', { id: delta.id, status: delta.state.current })).catch(() => {});
  }
});

// Clear the old global badge, including after a file-only upgrade. Recover the
// latest job from the existing offscreen document when the service worker wakes.
async function initializeActions() {
  await Promise.all([chrome.action.disable(), chrome.action.setBadgeText({ text: '' })]);
  if (await hasExportWorker()) {
    const snapshot = await sendWorker('snapshot');
    if (!exportState) exportState = snapshot?.state || null;
  }
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => chrome.tabs.get(tab.id).then(updateAction).catch(() => {})));
}
initializeActions().catch((error) => console.error('Could not update the export button:', error));
