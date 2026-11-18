import { extractAttachmentText } from './attachment.mjs';
import { decodeSheetClientVars, parseEmbeddedSheetRef, sheetBlockRequirements } from './sheet.mjs';
import { clientVarsDataToMarkdown, extractClientVars, mergeClientVarsPages } from './ssr.mjs';

const DEFAULT_ENDPOINT = process.env.BROWSEROS_MCP || 'http://127.0.0.1:9010/mcp';
const FEISHU_HOST = /(^|\.)(feishu\.cn|larkoffice\.com|larksuite\.com)$/;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const CHUNK_CHARS = 195000;

function isFeishu(url) {
  try { return FEISHU_HOST.test(new URL(url).hostname); } catch { return false; }
}

function streamHostFor(hostname) {
  return /(^|\.)feishu\.cn$/.test(hostname)
    ? 'internal-api-drive-stream.feishu.cn'
    : 'internal-api-drive-stream.larksuite.com';
}

function isEmptyRead(text) {
  const trimmed = String(text ?? '').trim();
  return !trimmed || trimmed === '(empty)' || trimmed === '(empty page)' || /^加载中\.{0,3}$/.test(trimmed) || /^表格加载中\.{0,3}$/.test(trimmed);
}

function formatSheetText(sheet) {
  const { rowStart, colStart, rowCount, colCount } = sheet.range;
  const byPos = new Map(sheet.cells.map((cell) => [`${cell.row}:${cell.col}`, cell.value ?? '']));
  const lines = [];
  for (let row = rowStart; row < rowStart + rowCount; row++) {
    const cols = [];
    for (let col = colStart; col < colStart + colCount; col++) {
      cols.push(String(byPos.get(`${row}:${col}`) ?? ''));
    }
    while (cols.length && cols[cols.length - 1] === '') cols.pop();
    if (cols.length) lines.push(cols.join('\t'));
  }
  return lines.join('\n') || '(empty sheet)';
}

// The MCP server wraps page output in an untrusted-content banner; keep only the JSON body.
export function unwrap(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('BrowserOS returned no result payload.');
  return text.slice(start, end + 1);
}

// Strips the untrusted-content wrapper around BrowserOS `read` output, returning plain text/markdown.
export function unwrapText(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((line) => line.startsWith('[UNTRUSTED_PAGE_CONTENT '));
  const end = lines.findIndex((line, index) => index > start && line.startsWith('[END_UNTRUSTED_PAGE_CONTENT '));
  if (start >= 0 && end > start) return lines.slice(start + 1, end).join('\n').trim();
  return String(text ?? '').trim();
}

// Parses the human-readable tab list, e.g. "[1718] https://tenant.feishu.cn/drive/home/ (主页)".
export function parseTabs(text) {
  const tabs = [];
  for (const line of text.split('\n')) {
    const match = /^\s*\[(\d+)\]\s+(\S+)/.exec(line);
    if (match) tabs.push({ id: Number(match[1]), url: match[2] });
  }
  return tabs;
}

export class BrowserOS {
  constructor({ endpoint = DEFAULT_ENDPOINT, fetchImpl = fetch, timeoutMs = 60000 } = {}) {
    this.endpoint = endpoint;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.session = null;
    this.nextId = 1;
  }

  async #send(message) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.session) headers['mcp-session-id'] = this.session;
    const response = await this.fetch(this.endpoint, {
      method: 'POST', headers, body: JSON.stringify(message),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.session = response.headers.get('mcp-session-id') || this.session;
    const text = await response.text();
    let payload = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const body = line.slice(6).trim();
      if (!body || body === '{}') continue;
      try { const parsed = JSON.parse(body); if (parsed.id === message.id) payload = parsed; } catch { /* keep waiting */ }
    }
    if (payload?.error) throw new Error(payload.error.message || 'BrowserOS request failed.');
    if (message.id !== undefined && !payload) throw new Error(`BrowserOS did not answer (HTTP ${response.status}).`);
    return payload?.result;
  }

  async initialize() {
    const result = await this.#send({
      jsonrpc: '2.0', id: this.nextId++, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'feishu-grab', version: '1.0.0' } },
    });
    await this.#send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return result;
  }

  async callTool(name, args) {
    const result = await this.#send({
      jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args },
    });
    const text = (result?.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    if (result?.isError) throw new Error(text || `BrowserOS tool ${name} failed.`);
    return text;
  }

  async tabs() {
    return parseTabs(await this.callTool('tabs', { action: 'list' }));
  }

  async openTab(url) {
    const text = await this.callTool('tabs', { action: 'new', url });
    const match = /page\s+(\d+)/.exec(text);
    if (!match) throw new Error('BrowserOS did not report the new page.');
    return { id: Number(match[1]), url };
  }

  async closeTab(page) {
    return this.callTool('tabs', { action: 'close', page });
  }

  async readPage(page, requestURL) {
    const func = `async () => { const r = await fetch(${JSON.stringify(requestURL)}, { credentials: 'include' }); return await r.text(); }`;
    return this.callTool('evaluate_in_page', { page, func, timeout: 20000, maxChars: 200000 });
  }

  async fetchJson(page, requestURL, { method = 'GET', body = null } = {}) {
    const func = `async () => {
      const cookies = Object.fromEntries(document.cookie.split(';').map((s) => {
        const idx = s.indexOf('=');
        return idx < 0 ? [s.trim(), ''] : [s.slice(0, idx).trim(), decodeURIComponent(s.slice(idx + 1).trim())];
      }));
      const headers = { accept: 'application/json, text/plain, */*' };
      const method = ${JSON.stringify(method)};
      if (method === 'POST') {
        headers['content-type'] = 'application/json';
        const csrf = cookies._csrf_token || cookies.swp_csrf_token || '';
        if (csrf) headers['x-csrftoken'] = csrf;
      }
      const r = await fetch(${JSON.stringify(requestURL)}, {
        method,
        credentials: 'include',
        headers,
        ${body !== null ? `body: ${JSON.stringify(typeof body === 'string' ? body : JSON.stringify(body))},` : ''}
      });
      return JSON.stringify({ ok: r.ok, status: r.status, text: await r.text() });
    }`;
    const raw = unwrapText(await this.callTool('evaluate_in_page', { page, func, timeout: 30000, maxChars: 200000 }));
    const result = JSON.parse(raw);
    let data = null;
    try { data = result.text ? JSON.parse(result.text) : null; } catch { data = null; }
    return { ok: result.ok, status: result.status, data, text: result.text };
  }

  async downloadBinary(page, requestURL, { maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
    const startFunc = `async () => {
      const r = await fetch(${JSON.stringify(requestURL)}, { credentials: 'include' });
      if (!r.ok) return JSON.stringify({ error: 'HTTP ' + r.status, status: r.status });
      const blob = await r.blob();
      if (blob.size > ${maxBytes}) return JSON.stringify({ error: 'File exceeds ' + ${maxBytes} + ' bytes limit (' + blob.size + ' bytes).', status: 413 });
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      globalThis.__feishuDownloads ??= new Map();
      const id = Math.random().toString(36).slice(2);
      globalThis.__feishuDownloads.set(id, b64);
      return JSON.stringify({ id, size: blob.size, b64Length: b64.length, contentType: r.headers.get('content-type') || '' });
    }`;
    const meta = JSON.parse(unwrapText(await this.callTool('evaluate_in_page', {
      page, func: startFunc, timeout: 60000, maxChars: 200000,
    })));
    if (meta.error) {
      const err = new Error(`File download failed (${meta.error}).`);
      err.status = meta.status;
      throw err;
    }
    const parts = [];
    try {
      for (let offset = 0; offset < meta.b64Length; offset += CHUNK_CHARS) {
        const chunkFunc = `() => globalThis.__feishuDownloads.get(${JSON.stringify(meta.id)}).slice(${offset}, ${offset + CHUNK_CHARS})`;
        parts.push(unwrapText(await this.callTool('evaluate_in_page', {
          page, func: chunkFunc, timeout: 20000, maxChars: 200000,
        })));
      }
    } finally {
      await this.callTool('evaluate_in_page', {
        page,
        func: `() => { globalThis.__feishuDownloads?.delete(${JSON.stringify(meta.id)}); return 'ok'; }`,
        timeout: 5000,
        maxChars: 1000,
      }).catch(() => {});
    }
    return {
      bytes: new Uint8Array(Buffer.from(parts.join(''), 'base64')),
      contentType: meta.contentType,
    };
  }
}

export async function browserOSAvailable({ endpoint = DEFAULT_ENDPOINT } = {}) {
  try {
    const response = await fetch(`${endpoint.replace(/\/mcp$/, '/')}`, { signal: AbortSignal.timeout(1500) });
    return response.status < 500;
  } catch { return false; }
}

function pickFeishuTab(tabs, wantedOrigin) {
  const feishu = tabs.filter((tab) => isFeishu(tab.url));
  const matching = wantedOrigin ? feishu.filter((tab) => new URL(tab.url).origin === wantedOrigin) : feishu;
  return matching.find((tab) => /\/drive(\/|$)/.test(new URL(tab.url).pathname)) || matching[0] || null;
}

export async function searchWithBrowserOS(query, { count = 20, offset = 0, site = null } = {}, { client = new BrowserOS(), searchURL } = {}) {
  await client.initialize();
  const wanted = site ? new URL(site).origin : null;
  const initialTabs = await client.tabs();
  let page = pickFeishuTab(initialTabs, wanted);
  if (!page) {
    const origin = wanted || initialTabs.filter((tab) => isFeishu(tab.url)).map((tab) => new URL(tab.url).origin)[0];
    if (!origin) throw new Error('Open a Feishu page in BrowserOS neo once, or pass --site https://<tenant>.feishu.cn/drive/home/.');
    page = await client.openTab(`${origin}/drive/home/`);
  }
  const url = searchURL(page.url, { query, offset, count });
  try {
    return { payload: unwrap(await client.readPage(page.id, url)), url };
  } catch (error) {
    if (!/Unknown page/i.test(error?.message || '')) throw error;
    const freshTabs = await client.tabs();
    const retryPage = pickFeishuTab(freshTabs, wanted) || await client.openTab(`${new URL(page.url).origin}/drive/home/`);
    const retryUrl = searchURL(retryPage.url, { query, offset, count });
    return { payload: unwrap(await client.readPage(retryPage.id, retryUrl)), url: retryUrl };
  }
}

async function readSheetViaBrowserOS(client, pageId, origin, sheetToken, { title = '', format = 'markdown', onlySheetIds = null } = {}) {
  const resource = await client.fetchJson(pageId, `${origin}/space/api/v3/sheet/resource/`, {
    method: 'POST',
    body: { path: ['comments'], token: sheetToken, sheetIDs: [] },
  });
  if (!resource.ok || resource.data?.code !== 0) {
    throw new Error(`Sheet resource lookup failed (HTTP ${resource.status}, code ${resource.data?.code}).`);
  }
  const availableSheetIds = Object.keys(resource.data?.data?.resource ?? {});
  const sheetIds = onlySheetIds?.length
    ? availableSheetIds.filter((id) => onlySheetIds.includes(id))
    : availableSheetIds;
  if (!sheetIds.length) throw new Error('Could not find any sheets in this workbook.');

  const sections = [];
  for (const sheetId of sheetIds) {
    const cv = await client.fetchJson(pageId, `${origin}/space/api/v3/sheet/client_vars`, {
      method: 'POST',
      body: { memberId: 0, schemaVersion: 9, openType: 1, token: sheetToken, sheetRange: { sheetId }, clientVersion: 'v0.0.1' },
    });
    if (!cv.ok || cv.data?.code !== 0 || cv.data?.data?.token !== sheetToken) {
      throw new Error(`Sheet client_vars failed (HTTP ${cv.status}, code ${cv.data?.code}).`);
    }
    const formulaPayloads = [];
    for (const blockId of sheetBlockRequirements(cv.data).formulaBlockIds) {
      const q = new URLSearchParams({ token: sheetToken, block_token: blockId, blockIds: blockId });
      const f = await client.fetchJson(pageId, `${origin}/space/api/v3/sheet/formula/data_block?${q}`);
      if (!f.ok || f.data?.code !== 0) throw new Error(`Formula block failed (HTTP ${f.status}, code ${f.data?.code}).`);
      formulaPayloads.push(f.data);
    }
    const decoded = decodeSheetClientVars(cv.data, formulaPayloads);
    const body = format === 'text' ? formatSheetText(decoded) : decoded.markdown;
    sections.push(sheetIds.length > 1 ? (format === 'text' ? `[${sheetId}]\n${body}` : `## Sheet ${sheetId}\n\n${body}`) : body);
  }

  const header = title ? (format === 'text' ? `${title}\n\n` : `# ${title}\n\n`) : '';
  return `${header}${sections.join('\n\n')}`.trim();
}

async function waitForBrowserOSHydration(client, pageId, { timeoutMs = 4000 } = {}) {
  if (typeof client.callTool !== 'function') return;
  const func = `async () => {
    const deadline = Date.now() + ${timeoutMs};
    while (Date.now() < deadline) {
      const txt = (document.body?.innerText || '').trim();
      if (txt && txt !== '加载中...' && txt !== '表格加载中...' && txt.length > 20) return 'ready';
      await new Promise((r) => setTimeout(r, 300));
    }
    return 'timeout';
  }`;
  await client.callTool('evaluate_in_page', { page: pageId, func, timeout: timeoutMs + 2000, maxChars: 200 }).catch(() => {});
}

async function readDocxViaBrowserOS(client, pageId, origin, url, { title = '', docToken = '', format = 'markdown' } = {}) {
  if (typeof client.readPage !== 'function') return null;
  let html;
  try {
    html = unwrapText(await client.readPage(pageId, url));
  } catch {
    return null;
  }
  const rawVars = extractClientVars(html);
  let initialData = null;
  if (rawVars) {
    try { initialData = JSON.parse(rawVars); } catch { initialData = null; }
  }
  if (!initialData?.block_map) return null;

  let data = initialData;
  if (initialData.has_more && Array.isArray(initialData.next_cursors) && initialData.next_cursors.length && docToken && typeof client.fetchJson === 'function') {
    const pages = [];
    let cursors = initialData.next_cursors;
    let guard = 0;
    while (cursors?.length && guard++ < 40) {
      const next = [];
      for (const cursor of cursors) {
        const res = await client.fetchJson(
          pageId,
          `${origin}/space/api/docx/pages/client_vars?id=${encodeURIComponent(docToken)}&cursor=${encodeURIComponent(cursor)}&limit=50`,
        ).catch(() => null);
        if (!res?.ok || res.data?.code !== 0 || !res.data?.data) continue;
        pages.push(res.data.data);
        if (res.data.data.has_more && Array.isArray(res.data.data.next_cursors)) {
          next.push(...res.data.data.next_cursors);
        }
      }
      cursors = next;
    }
    if (pages.length) data = mergeClientVarsPages(initialData, pages);
  }

  const parsed = clientVarsDataToMarkdown(data, html);
  if (!parsed) return null;

  const extraSheets = [];
  if (parsed.sheetFallbacks?.length && typeof client.fetchJson === 'function') {
    for (const item of parsed.sheetFallbacks) {
      const { token: sheetToken, sheetId } = parseEmbeddedSheetRef(item.token);
      if (!sheetToken) continue;
      const decoded = await readSheetViaBrowserOS(client, pageId, origin, sheetToken, {
        onlySheetIds: sheetId ? [sheetId] : null,
        format,
      }).catch(() => null);
      if (decoded) extraSheets.push(decoded);
    }
  }

  const parts = [];
  const docTitle = parsed.title || title;
  const body = parsed.markdown?.trim() || '';
  if (body) parts.push(body);
  if (extraSheets.length) parts.push(...extraSheets);
  const combined = parts.join('\n\n').trim();
  if (!combined) return null;
  if (docTitle && !combined.startsWith(`# ${docTitle}`)) return `# ${docTitle}\n\n${combined}`;
  return combined;
}

async function readFileViaBrowserOS(client, pageId, parsedUrl, fileToken, { mountNodeToken, mountPoint, title = '', fileType = '', format = 'markdown', extractAttachment = extractAttachmentText } = {}) {
  const host = streamHostFor(parsedUrl.hostname);
  const query = new URLSearchParams({
    mount_node_token: mountNodeToken,
    mount_point: mountPoint,
    policy: 'equal',
    preview_type: '16',
  });
  let downloaded;
  try {
    downloaded = await client.downloadBinary(pageId, `https://${host}/space/api/box/stream/download/preview/${encodeURIComponent(fileToken)}/?${query}`);
  } catch (error) {
    if (error.status !== 400 && error.status !== 404) throw error;
    downloaded = await client.downloadBinary(pageId, `https://${host}/space/api/box/stream/download/all/${encodeURIComponent(fileToken)}/?${new URLSearchParams({ mount_node_token: mountNodeToken, mount_point: mountPoint })}`);
  }
  const filename = title || (fileType ? `${fileToken}.${fileType}` : '');
  const extracted = extractAttachment(downloaded.bytes, {
    filename,
    contentType: downloaded.contentType,
    format,
  });
  if (!title) return extracted;
  const header = format === 'text' ? `${title}\n\n` : `# ${title}\n\n`;
  return `${header}${extracted}`;
}

async function resolveWikiNode(client, pageId, origin, wikiToken) {
  const res = await client.fetchJson(pageId, `${origin}/space/api/wiki/v2/tree/get_node/?wiki_token=${encodeURIComponent(wikiToken)}`);
  if (!res.ok || res.data?.code !== 0 || !res.data?.data) return null;
  const node = res.data.data;
  let fileType = '';
  try { fileType = JSON.parse(node.icon_info || '{}').file_type || ''; } catch { /* ignore */ }
  return {
    objType: node.obj_type,
    objToken: node.obj_token,
    title: node.title || '',
    fileType,
  };
}

export async function readDocumentWithBrowserOS(
  url,
  { format = 'markdown' } = {},
  { client = new BrowserOS(), available = browserOSAvailable, extractAttachment = extractAttachmentText } = {},
) {
  if (!isFeishu(url)) throw new Error('url must be a Feishu or Lark link.');
  if (!(await available())) {
    throw new Error('BrowserOS neo is not running; start BrowserOS neo to read Feishu pages in the background without stealing focus.');
  }
  await client.initialize();
  const parsedUrl = new URL(url);
  const tabs = await client.tabs();
  const existing = tabs.find((tab) => tab.url === url);
  const originTab = existing || tabs.find((tab) => isFeishu(tab.url) && new URL(tab.url).origin === parsedUrl.origin);

  const sheetMatch = /^\/(?:sheets|spreadsheet)\/([A-Za-z0-9]+)/.exec(parsedUrl.pathname);
  if (sheetMatch) {
    const page = originTab || await client.openTab(`${parsedUrl.origin}/drive/home/`);
    try {
      return await readSheetViaBrowserOS(client, page.id, parsedUrl.origin, sheetMatch[1], { format });
    } finally {
      if (!originTab) await client.closeTab(page.id).catch(() => {});
    }
  }

  const fileMatch = /^\/file\/([A-Za-z0-9]+)/.exec(parsedUrl.pathname);
  if (fileMatch) {
    const page = originTab || await client.openTab(`${parsedUrl.origin}/drive/home/`);
    try {
      return await readFileViaBrowserOS(client, page.id, parsedUrl, fileMatch[1], {
        mountNodeToken: fileMatch[1],
        mountPoint: 'explorer',
        format,
        extractAttachment,
      });
    } finally {
      if (!originTab) await client.closeTab(page.id).catch(() => {});
    }
  }

  const docxMatch = /^\/docx\/([A-Za-z0-9]+)/.exec(parsedUrl.pathname);
  if (docxMatch && originTab) {
    const ssr = await readDocxViaBrowserOS(client, originTab.id, parsedUrl.origin, url, {
      docToken: docxMatch[1],
      format,
    });
    if (ssr) return ssr;
  }

  const wikiMatch = /^\/wiki\/([A-Za-z0-9]+)/.exec(parsedUrl.pathname);
  if (wikiMatch && originTab && typeof client.fetchJson === 'function') {
    const node = await resolveWikiNode(client, originTab.id, parsedUrl.origin, wikiMatch[1]).catch(() => null);
    if (node?.objType === 3 && node.objToken) {
      return readSheetViaBrowserOS(client, originTab.id, parsedUrl.origin, node.objToken, { title: node.title, format });
    }
    if (node?.objType === 12 && node.objToken) {
      return readFileViaBrowserOS(client, originTab.id, parsedUrl, node.objToken, {
        mountNodeToken: wikiMatch[1],
        mountPoint: 'wiki',
        title: node.title,
        fileType: node.fileType,
        format,
        extractAttachment,
      });
    }
    if (node?.objType === 22 || !node) {
      const ssr = await readDocxViaBrowserOS(client, originTab.id, parsedUrl.origin, url, {
        title: node?.title || '',
        docToken: node?.objToken || '',
        format,
      });
      if (ssr) return ssr;
    }
  }

  const page = existing || await client.openTab(url);
  try {
    let text = unwrapText(await client.callTool('read', { page: page.id, format }));
    if (isEmptyRead(text)) {
      await waitForBrowserOSHydration(client, page.id);
      text = unwrapText(await client.callTool('read', { page: page.id, format }));
    }
    if (!isEmptyRead(text)) return text;

    if (wikiMatch && typeof client.fetchJson === 'function') {
      const node = await resolveWikiNode(client, page.id, parsedUrl.origin, wikiMatch[1]).catch(() => null);
      if (node?.objType === 3 && node.objToken) {
        return await readSheetViaBrowserOS(client, page.id, parsedUrl.origin, node.objToken, { title: node.title, format });
      }
      if (node?.objType === 12 && node.objToken) {
        return await readFileViaBrowserOS(client, page.id, parsedUrl, node.objToken, {
          mountNodeToken: wikiMatch[1],
          mountPoint: 'wiki',
          title: node.title,
          fileType: node.fileType,
          format,
          extractAttachment,
        });
      }
    }
    return text;
  } finally {
    if (!existing) await client.closeTab(page.id).catch(() => {});
  }
}
