import { validateDocumentURL } from './exporter.mjs';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings.mjs';

const $ = (id) => document.getElementById(id);
let sourceTab;
let currentState;
let pending = false;
let settings = { ...DEFAULT_SETTINGS };
const tabValue = new URLSearchParams(location.hash.slice(1)).get('tab');
const fixedTabId = tabValue && /^\d+$/.test(tabValue) ? Number(tabValue) : null;
let sourceWindowId;
let sourceRevision = 0;
// Read the tab afresh after navigation; export snapshots describe a job, not
// the document currently selected in the browser.
async function refreshSource() {
  const revision = ++sourceRevision;
  let tab;
  try {
    tab = fixedTabId !== null ? await chrome.tabs.get(fixedTabId)
      : (await chrome.tabs.query({ active: true, ...(sourceWindowId === undefined ? { currentWindow: true } : { windowId: sourceWindowId }) }))[0];
    if (revision !== sourceRevision) return;
    sourceWindowId = tab?.windowId ?? sourceWindowId;
    validateDocumentURL(tab?.url);
  } catch { tab = null; }
  if (revision !== sourceRevision) return;
  sourceTab = tab;
  render(currentState);
}
function status(text, error = false) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
const cleanTitle = (title) => (title || 'Feishu document').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').replace(/ - (飞书云文档|Feishu Docs|飞书)$/, '');
async function request(name, data = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'export-service', command: name, ...data });
  if (response?.error || response?.value?.error) throw new Error(response.error || response.value.error);
  return response?.value;
}
async function command(name, data = {}) { return (await request(name, data))?.state || null; }
function applyTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
function showFormat() {
  $('format-label').textContent = settings.format === 'folder' ? 'Markdown folder' : 'Markdown archive';
  $('format-extension').textContent = settings.format === 'folder' ? 'Folder' : '.zip';
  $('destination').textContent = settings.format === 'zip' && settings.askWhere ? 'Choose a save location for each ZIP'
    : `Save to: Chrome downloads${settings.subfolder ? ` / ${settings.subfolder}` : ''}`;
}
function updateSettingsFields() {
  const folder = $('setting-format').value === 'folder';
  $('setting-ask').disabled = folder;
  $('folder-hint').hidden = !folder;
}
function settingsDraft() {
  return normalizeSettings({ format: $('setting-format').value, subfolder: $('setting-subfolder').value,
    askWhere: $('setting-ask').checked, theme: $('setting-theme').value, whiteboards: $('setting-whiteboards').value });
}
function updateDraft() {
  updateSettingsFields();
  $('clear-subfolder').hidden = !$('setting-subfolder').value;
  $('setting-subfolder').removeAttribute('aria-invalid');
  try {
    const changed = JSON.stringify(settingsDraft()) !== JSON.stringify(settings);
    $('settings-save').disabled = !changed;
    $('settings-status').className = '';
    $('settings-status').textContent = changed ? 'Unsaved changes' : 'No changes';
  } catch (error) {
    $('settings-save').disabled = true;
    $('setting-subfolder').setAttribute('aria-invalid', 'true');
    $('settings-status').className = 'error';
    $('settings-status').textContent = error.message;
  }
}
function settingsView(open) {
  $('settings-panel').hidden = !open;
  $('export-view').hidden = open;
  $('settings-open').hidden = open;
  $('settings-back').hidden = !open;
  if (open) {
    $('setting-format').value = settings.format;
    $('setting-subfolder').value = settings.subfolder;
    $('setting-ask').checked = settings.askWhere;
    $('setting-whiteboards').value = settings.whiteboards;
    $('setting-theme').value = settings.theme;
    updateDraft();
  } else applyTheme(settings.theme);
  window.scrollTo(0, 0);
}
$('settings-open').addEventListener('click', () => settingsView(true));
$('settings-back').addEventListener('click', () => settingsView(false));
$('setting-format').addEventListener('change', updateDraft);
$('setting-ask').addEventListener('change', updateDraft);
$('setting-whiteboards').addEventListener('change', updateDraft);
$('setting-subfolder').addEventListener('input', updateDraft);
$('setting-theme').addEventListener('change', () => { applyTheme($('setting-theme').value); updateDraft(); });
$('clear-subfolder').addEventListener('click', () => {
  $('setting-subfolder').value = '';
  updateDraft();
  $('setting-subfolder').focus();
});
$('chrome-download-settings').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://settings/downloads' }));
$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('settings-save').disabled = true;
  try {
    const value = settingsDraft();
    settings = (await request('settings-save', { settings: value })).settings;
    applyTheme(settings.theme);
    showFormat();
    $('settings-status').className = 'success';
    $('settings-status').textContent = 'Settings saved.';
  } catch (error) {
    $('settings-status').className = 'error';
    $('settings-status').textContent = error.message;
  } finally {
    try { $('settings-save').disabled = JSON.stringify(settingsDraft()) === JSON.stringify(settings); }
    catch { $('settings-save').disabled = true; }
  }
});
function showResult(result) {
  const { integrity, issues } = result.report.documents[0];
  const labels = { complete: 'All checks passed', degraded: 'Some content needs review', incomplete: 'Some content is missing' };
  $('result-heading').textContent = labels[integrity.verdict];
  $('verdict').textContent = integrity.verdict.toUpperCase();
  $('verdict').className = `badge ${integrity.verdict}`;
  $('summary').textContent = `${result.fileCount} files · ${(result.totalBytes / 1024).toLocaleString('en', { maximumFractionDigits: 0 })} KB · Includes an integrity report`;
  $('checks').replaceChildren();
  for (const check of integrity.checks) {
    const evidence = integrity.evidence;
    const media = evidence.media?.[check.name];
    if (check.status === 'pass' && (media?.expected === 0 || ['block_recognition', 'block_structure', 'renderability', 'sheetFallbacks'].includes(check.name))) continue;
    const friendly = {
      body: 'Document text saved.',
      pagination: 'All document pages retrieved.',
      comments: `${evidence.comments?.threads || 0} comment thread(s) and ${evidence.comments?.replies || 0} reply/replies saved.`,
      structuredSheets: `${media?.exported || 0} embedded table(s) saved with cell values and formulas.`,
      whiteboards: `${media?.exported || 0} whiteboard(s) saved as page screenshots.`,
    };
    const item = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = `check-mark ${check.status}`;
    icon.textContent = check.status === 'pass' ? '✓' : '!';
    const detail = document.createElement('span');
    detail.textContent = check.status === 'pass' ? friendly[check.name] || check.detail : check.detail;
    item.append(icon, detail);
    $('checks').append(item);
  }
  $('issues').replaceChildren();
  for (const issue of issues) { const item = document.createElement('li'); item.textContent = issue; $('issues').append(item); }
  $('issue-details').hidden = !issues.length;
  $('result').hidden = false;
}
function render(state) {
  currentState = state;
  const running = state?.status === 'running';
  const busy = running || state?.status === 'saving';
  const sameDocument = !!(sourceTab && state?.source && validateDocumentURL(sourceTab.url).href === state.source.url);
  const previous = !!state?.source && !sameDocument && !busy;
  $('document-heading').textContent = sourceTab ? cleanTitle(sourceTab.title) : 'Open a Feishu document';
  $('source').textContent = sourceTab ? new URL(sourceTab.url).hostname : '';
  $('export').disabled = pending || busy || !sourceTab;
  $('export').textContent = sameDocument ? 'Export again' : 'Export';
  $('active-job').hidden = !busy || sameDocument;
  $('active-job').textContent = busy && !sameDocument ? `Exporting: ${cleanTitle(state.source.title)}` : '';
  $('previous-export').hidden = !previous;
  $('previous-title').textContent = previous ? cleanTitle(state.source.title) : '';
  $('previous-status').textContent = previous ? state.message : '';
  $('previous-download').hidden = !previous || !state.canDownload;
  $('previous-download').disabled = pending || busy;
  $('previous-download').textContent = state?.settings?.format === 'folder' ? 'Save previous folder' : 'Download previous ZIP';
  $('cancel').hidden = !running && !(state?.status === 'saving' && state.settings?.format === 'folder');
  $('cancel').disabled = pending;
  $('download').hidden = !sameDocument || !state?.canDownload;
  $('download').disabled = pending || busy;
  $('download').textContent = state?.settings?.format === 'folder' ? 'Save folder again' : 'Download ZIP again';
  $('progress-area').hidden = !busy;
  $('progress').value = state?.progress || 0;
  $('result').hidden = !sameDocument || !state?.result;
  if (sameDocument && state?.result) showResult(state.result);
  const message = sameDocument || busy ? state?.message : null;
  status(message || (sourceTab ? 'Ready to export.' : 'Switch to a Feishu or Lark document to export it.'), sameDocument && state?.status === 'error');
}
async function perform(name, data) {
  if (pending) return;
  pending = true;
  if (name === 'start') currentState = null;
  render(currentState);
  try { render(await command(name, data)); }
  catch (error) { status(error.message, true); }
  finally {
    pending = false;
    const busy = ['running', 'saving'].includes(currentState?.status);
    $('export').disabled = busy || !sourceTab;
    $('cancel').disabled = false;
    $('download').disabled = busy;
    $('previous-download').disabled = busy;
  }
}
$('export').addEventListener('click', async () => {
  await refreshSource();
  if (sourceTab) await perform('start', { source: { id: sourceTab.id, url: sourceTab.url } });
});
$('cancel').addEventListener('click', () => perform('cancel'));
$('download').addEventListener('click', () => perform('download-again'));
$('previous-download').addEventListener('click', () => perform('download-again'));
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  const relevant = fixedTabId !== null ? id === fixedTabId : tab.active && tab.windowId === sourceWindowId;
  if (relevant && (change.url !== undefined || change.title !== undefined || change.status === 'complete')) void refreshSource();
});
chrome.tabs.onActivated.addListener(({ windowId }) => {
  if (fixedTabId === null && windowId === sourceWindowId) void refreshSource();
});
chrome.tabs.onRemoved.addListener((id) => {
  if (id === sourceTab?.id || id === fixedTabId) void refreshSource();
});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.target === 'export-state' && sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('extension/offscreen.html')) render(message.state);
});

// An already-installed unpacked 0.1.0 can receive files without bringing Chrome
// forward. On its next user-opened popup, reload to register the new manifest.
if (chrome.runtime.getManifest().version !== '0.2.7') {
  status('Updating Feishu Grabber. Click the toolbar icon again when it is ready.');
  chrome.runtime.reload();
} else {
  try {
    settings = (await request('settings-get')).settings;
    applyTheme(settings.theme);
  } catch (error) { status(`Could not load settings: ${error.message}`, true); }
  showFormat();
  await refreshSource();
  try { render(await command('snapshot')); }
  catch (error) { render(null); status(error.message, true); }
}
