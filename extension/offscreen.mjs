import { exportDocument } from './exporter.mjs';
import { createBrowserTransport } from './browser-transport.mjs';
import { normalizeSettings, downloadPath } from './settings.mjs';

let state = null;
let controller;
let archiveURL;
let archiveName;
let exportedFiles;
let exportedTitle;
const downloadWaiters = new Map();
async function service(command, data = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'export-service', command, ...data });
  if (response.error) throw new Error(response.error);
  return response.value;
}
function publish(update) {
  Object.assign(state, update);
  chrome.runtime.sendMessage({ target: 'export-state', state }).catch(() => {});
}
function packageArchive(result, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./zip-worker.mjs', import.meta.url), { type: 'module' });
    const cleanup = () => { worker.terminate(); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new DOMException('Export cancelled.', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => { cleanup(); data.error ? reject(new Error(data.error)) : resolve(data.archive); };
    worker.onerror = () => { cleanup(); reject(new Error('Could not prepare the ZIP archive. Try exporting again.')); };
    worker.postMessage({ title: result.title, files: result.files });
  });
}
function downloadState(status) {
  if (status === 'complete') publish({ status: 'complete', progress: 1, message: 'ZIP saved to your Chrome download location.' });
  if (status === 'interrupted') publish({ status: 'error', message: 'Download interrupted. Select Download ZIP again to retry.' });
}
async function download() {
  if (!archiveURL) throw new Error('No archive is ready to download.');
  publish({ status: 'saving', message: 'Saving ZIP…', downloadId: null });
  try {
    const item = await service('download', { url: archiveURL, filename: downloadPath(state.settings.subfolder, archiveName), saveAs: state.settings.askWhere });
    state.downloadId = item.id;
    // Register the ID before checking the status, so an instant download cannot
    // finish between its completion event and the start response.
    downloadState(await service('download-status', { id: item.id }));
  } catch (error) {
    publish({ status: 'error', message: `Could not save the ZIP: ${error.message}. Select Download ZIP again to retry.` });
  }
}
function waitForDownload(id, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { downloadWaiters.delete(id); signal.removeEventListener('abort', abort); };
    const finish = (downloadStatus) => {
      if (downloadStatus === 'complete') { cleanup(); resolve(); }
      if (downloadStatus === 'interrupted') { cleanup(); reject(new Error('A file download was interrupted.')); }
    };
    const abort = () => {
      service('cancel-download', { id }).catch(() => {});
      cleanup(); reject(new DOMException('Export cancelled.', 'AbortError'));
    };
    downloadWaiters.set(id, finish);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    service('download-status', { id }).then((value) => {
      if (!value) throw new Error('The file download could not be found.');
      finish(value);
    }).catch((error) => { cleanup(); reject(error); });
  });
}
async function saveFolder(signal) {
  if (!exportedFiles) throw new Error('No files are ready to save.');
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-');
  const directory = downloadPath(state.settings.subfolder, `${exportedTitle} ${stamp} ${crypto.randomUUID().slice(0, 8)}`);
  const entries = Object.entries(exportedFiles);
  publish({ status: 'saving', message: 'Saving document folder…', destination: directory, savedFiles: 0, downloadId: null });
  for (const [name, bytes] of entries) {
    signal.throwIfAborted();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    try {
      const { id } = await service('download', { url, filename: `${directory}/${name}`, saveAs: false });
      await waitForDownload(id, signal);
      publish({ savedFiles: state.savedFiles + 1, progress: 0.9 + 0.1 * (state.savedFiles + 1) / entries.length,
        message: `Saving files: ${state.savedFiles + 1} of ${entries.length}` });
    } finally { URL.revokeObjectURL(url); }
  }
  publish({ status: 'complete', progress: 1, message: `Folder saved: ${directory} · ${entries.length} files` });
}
function reportFailure(error, signal) {
  const partial = state.savedFiles ? ` ${state.savedFiles} file(s) were saved; the partial folder remains in downloads.` : '';
  publish({ status: signal.aborted ? 'cancelled' : 'error', message: signal.aborted
    ? `Export cancelled.${partial || ' No new files were saved.'}` : `${error.message}${partial}` });
}
async function saveAgain() {
  controller = new AbortController();
  const { signal } = controller;
  try {
    if (state.settings.format === 'folder') await saveFolder(signal);
    else await download();
  } catch (error) { reportFailure(error, signal); }
  finally { controller = null; }
}
async function run(source, signal) {
  try {
    const bridge = {
      read: (tabId, origin, url, options, requestId) => service('read', { tabId, origin, url, options, requestId }),
      abort: (tabId, ids) => service('abort', { tabId, ids }),
      capture: (tabId, board) => service('capture', { tabId, board }),
      bitableTables: (tabId) => service('bitable-tables', { tabId }),
    };
    const result = await exportDocument({
      url: source.url, signal, transport: createBrowserTransport(source.id, source.url, signal, bridge),
      captureBoards: state.settings.whiteboards !== 'off',
      progress: ({ fraction, message }) => publish({ progress: fraction, message }),
    });
    exportedTitle = result.title;
    exportedFiles = state.settings.format === 'folder' ? result.files : null;
    if (state.settings.format === 'zip') {
      publish({ message: 'Packaging archive…' });
      const archive = await packageArchive(result, signal);
      signal.throwIfAborted();
      archiveURL = URL.createObjectURL(new Blob([archive], { type: 'application/zip' }));
      archiveName = `${result.title}.zip`;
    }
    publish({ progress: 0.9, canDownload: true, result: { fileCount: Object.keys(result.files).length, totalBytes: result.totalBytes, report: result.report } });
    if (state.settings.format === 'folder') await saveFolder(signal);
    else await download();
  } catch (error) { reportFailure(error, signal);
  } finally { controller = null; }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== 'export-worker' || sender.id !== chrome.runtime.id) return;
  try {
    switch (message.command) {
      case 'start':
        if (controller || state?.status === 'saving') throw new Error('An export is already running. Wait for it or cancel it first.');
        if (archiveURL) URL.revokeObjectURL(archiveURL);
        archiveURL = null;
        exportedFiles = null;
        controller = new AbortController();
        state = { id: crypto.randomUUID(), source: message.source, settings: normalizeSettings(message.settings), savedFiles: 0, status: 'running', progress: 0, message: 'Starting export…', result: null, canDownload: false, downloadId: null };
        publish({});
        void run(message.source, controller.signal);
        break;
      case 'cancel':
        if (state?.status === 'running' || (state?.status === 'saving' && state.settings.format === 'folder')) { controller?.abort(); publish({ message: 'Cancelling…' }); }
        break;
      case 'download-again':
        if (controller || state?.status === 'saving') throw new Error('An export is already running.');
        if (!state?.canDownload) throw new Error('No export is ready to save.');
        void saveAgain();
        break;
      case 'download-state':
        if (downloadWaiters.has(message.id)) downloadWaiters.get(message.id)(message.status);
        else if (message.id === state?.downloadId) downloadState(message.status);
        break;
      case 'snapshot': break;
      default: throw new Error('Unknown export operation.');
    }
    respond({ state });
  } catch (error) { respond({ error: error.message }); }
});
