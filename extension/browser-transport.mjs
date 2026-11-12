import { validateDocumentURL } from './exporter.mjs';

// Runs in the source tab's isolated world. Session cookies stay in Chrome.
// Only these read endpoints are exposed; this is not an arbitrary request bridge.
async function readFromPage(expectedOrigin, url, options, requestId) {
  const allowed = /^\/space\/api\/(?:wiki\/v2\/tree\/get_node\/?|docx\/pages\/client_vars|comment\/(?:commentid\/all|batch)|v3\/sheet\/(?:resource\/?|client_vars|formula\/data_block)|bitable\/[^/]+\/tablesv3\/?|v1\/bitable\/[^/]+\/records)$/;
  const target = new URL(url);
  if (location.origin !== expectedOrigin || target.origin !== expectedOrigin
      || (!/^\/(docx|wiki|docs)\/[A-Za-z0-9]+\/?$/.test(target.pathname) && !allowed.test(target.pathname))) {
    throw new Error('The source tab changed or the request is outside this document site.');
  }
  if (options.method === 'POST' && !/^\/space\/api\/(comment\/|v3\/sheet\/|bitable\/[^/]+\/tablesv3)/.test(target.pathname)) {
    throw new Error('Unsupported document request.');
  }
  const requests = globalThis.__feishuGrabberRequests ??= new Map();
  const controller = new AbortController();
  requests.set(requestId, controller);
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const headers = { ...options.headers };
    if (options.method === 'POST' || target.pathname.startsWith('/space/api/v3/sheet/')) {
      const csrf = document.cookie.split(';').map((part) => part.trim())
        .find((part) => part.startsWith('_csrf_token=') || part.startsWith('swp_csrf_token='));
      if (csrf) headers['x-csrftoken'] = decodeURIComponent(csrf.slice(csrf.indexOf('=') + 1));
    }
    const response = await fetch(target.href, {
      method: options.method || 'GET', headers, body: options.body,
      credentials: 'include', signal: controller.signal,
    });
    return { status: response.status, url: response.url, text: await response.text() };
  } catch (error) {
    return { error: error.name === 'AbortError' ? 'Document request cancelled or timed out.' : error.message };
  } finally {
    clearTimeout(timer);
    requests.delete(requestId);
  }
}

export async function readSourceTab(tabId, origin, url, options, requestId) {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId }, func: readFromPage, args: [origin, url, options, requestId],
  });
  return execution?.result;
}

export function abortSourceRequests(tabId, ids) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: (ids) => ids.forEach((id) => globalThis.__feishuGrabberRequests?.get(id)?.abort()),
    args: [ids],
  });
}

// Reads the Bitable table tab bar from the loaded source page: each tab's
// class carries its table id (bitable-new-table-item-<tableId>). Injected
// function must be self-contained.
export async function readBitableTablesTab() {
  const tables = [];
  for (const element of document.querySelectorAll('.bitable-new-table-item')) {
    const match = /bitable-new-table-item-([A-Za-z0-9]+)\b/.exec(element.className);
    if (!match) continue;
    tables.push({ id: match[1], name: (element.querySelector('.bitable-new-table-tab__item-name')?.textContent || '').trim() });
  }
  return tables;
}

export async function readBitableTables(tabId) {
  const [execution] = await chrome.scripting.executeScript({ target: { tabId }, func: readBitableTablesTab });
  return execution?.result || [];
}

export function createBrowserTransport(tabId, source, signal, bridge = { read: readSourceTab, abort: abortSourceRequests, capture: null, bitableTables: null }) {
  const sourceURL = validateDocumentURL(source);
  const requests = new Set();
  signal.addEventListener('abort', () => {
    const ids = [...requests];
    bridge.abort(tabId, ids).catch(() => {});
  }, { once: true });
  return {
    async request(url, options = {}) {
      signal.throwIfAborted();
      const requestId = crypto.randomUUID();
      requests.add(requestId);
      try {
        const result = await bridge.read(tabId, sourceURL.origin, url, options, requestId);
        signal.throwIfAborted();
        if (!result || result.error) throw new Error(result?.error || 'Could not read the source tab. Reopen the document and try again.');
        if (result.status === 401) throw new Error('Your session expired. Sign in to Feishu in the source tab and try again.');
        if (result.status === 403) throw new Error('You do not have permission to export this content.');
        if (result.status < 200 || result.status >= 300) throw new Error(`Document request failed (HTTP ${result.status}).`);
        if (new URL(result.url).origin !== sourceURL.origin) throw new Error('Sign in to Feishu in the source tab and try again.');
        return result.text;
      } finally { requests.delete(requestId); }
    },
    async capture(board) {
      signal.throwIfAborted();
      if (typeof bridge.capture !== 'function') throw new Error('Whiteboard capture is unavailable in this export mode.');
      const result = await bridge.capture(tabId, board);
      signal.throwIfAborted();
      if (!result || result.error) throw new Error(result?.error || 'Whiteboard capture failed. Keep the source tab open and try again.');
      return {
        bytes: Uint8Array.from(atob(result.data), (char) => char.charCodeAt(0)),
        route: result.route, width: result.width, height: result.height, sha256: result.sha256,
      };
    },
    async bitableTables() {
      signal.throwIfAborted();
      if (typeof bridge.bitableTables !== 'function') return null;
      const tables = await bridge.bitableTables(tabId);
      signal.throwIfAborted();
      return tables;
    },
    async media(url) {
      signal.throwIfAborted();
      const target = new URL(url);
      const allowedHost = sourceURL.hostname.endsWith('.feishu.cn') || sourceURL.hostname === 'feishu.cn'
        ? 'internal-api-drive-stream.feishu.cn' : 'internal-api-drive-stream.larksuite.com';
      if (target.protocol !== 'https:' || target.hostname !== allowedHost
          || !target.pathname.startsWith('/space/api/box/stream/download/preview/')) throw new Error('Unsupported resource address.');
      const response = await fetch(url, { credentials: 'include', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
      if (!response.ok) throw new Error(`Resource download failed (HTTP ${response.status}).`);
      const chunks = [];
      let size = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 100 * 1024 * 1024) throw new Error('This resource exceeds the 100 MB export limit.');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { bytes, contentType: response.headers.get('content-type') || '' };
    },
  };
}
