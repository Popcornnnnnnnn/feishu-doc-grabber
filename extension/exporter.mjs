import { extractClientVars, clientVarsDataToMarkdown, mergeClientVarsPages, renderMarkdownImagesInHtmlTables, countMarkdownImagesInHtmlTables } from '../lib/ssr.mjs';
import { collectCommentIds, normalizeCommentThreads, applyComments, commentStats } from '../lib/comments.mjs';
import { evaluateIntegrity } from '../lib/integrity.mjs';
import { validateDownloadedPayload } from '../lib/media.mjs';
import { parseEmbeddedSheetRef, sheetBlockRequirements, decodeSheetClientVars } from '../lib/sheet.mjs';

export function validateDocumentURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Open a Feishu or Lark document, then click the extension icon.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !/(^|\.)(feishu\.cn|larkoffice\.com|larksuite\.com)$/.test(url.hostname)
      || !/^\/(docx|wiki|docs|base)\/[A-Za-z0-9]+\/?$/.test(url.pathname)) {
    throw new Error('Open a Feishu or Lark document, then click the extension icon.');
  }
  url.hash = '';
  url.search = '';
  return url;
}

export function safeName(value) {
  const name = String(value || 'Untitled').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 120).replace(/[. ]+$/g, '');
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name || 'Untitled';
}

// Bitable payloads declare encodingProtocol compression 1, so both tablesv3
// metadata and records arrive as base64-wrapped gzip JSON. fflate ships in the
// extension bundle (vendor) and in node_modules for tests. Loaded lazily:
// service workers do not allow top-level await.
let gunzipSyncPromise;
function bitableGunzip() {
  gunzipSyncPromise ??= (async () => {
    try { return (await import('../vendor/fflate.mjs')).gunzipSync; }
    catch { try { return (await import('fflate')).gunzipSync; } catch { return null; } }
  })();
  return gunzipSyncPromise;
}

async function decodeBitablePayload(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value.startsWith('H4sIA')) {
    const gunzipSync = await bitableGunzip();
    if (!gunzipSync) throw new Error('this build cannot decompress Bitable payloads.');
    return JSON.parse(new TextDecoder().decode(gunzipSync(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)))));
  }
  if (typeof value === 'string') return JSON.parse(value);
  throw new Error('the Bitable response has an unexpected encoding.');
}

const BITABLE_DATE_TYPES = new Set([5, 1001, 1002]);

function bitableValueToText(value, field) {
  const type = Number(field?.type || 0);
  const options = new Map((field?.property?.options || []).map((option) => [option.id, option.name]));
  const render = (value) => {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(render).filter((text) => text !== '').join(', ');
    if (typeof value === 'object') {
      if (Array.isArray(value.users)) return value.users.map((user) => user.name).filter(Boolean).join(', ');
      if (typeof value.text === 'string') return value.text;
      if (Array.isArray(value.link)) return value.link.map((link) => link.url || link.href || '').filter(Boolean).join(' ');
      if (typeof value.name === 'string') return value.name;
      if (value.value !== undefined && typeof value.value !== 'object') return render(value.value);
      return '';
    }
    if (typeof value === 'string') return options.get(value) ?? value;
    if (typeof value === 'number') {
      if (BITABLE_DATE_TYPES.has(type) && value > 1_000_000_000) {
        const milliseconds = value > 1e12 ? value : value * 1000;
        return new Date(milliseconds).toISOString().slice(0, 16).replace('T', ' ');
      }
      return String(value);
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
  };
  return render(value).trim();
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function exportBitableCSV({ url, sourceQuery = null, appToken, hintedTitle = '', transport, signal, stage, json, postJSON, addFile, issues = [] }) {
  // The table tab bar in the loaded source page carries table ids in its item
  // class names; without it we can only export the table named in the URL.
  stage(0.05, 'Reading Bitable tables');
  let tables = typeof transport.bitableTables === 'function' ? await transport.bitableTables() : null;
  if (!Array.isArray(tables) || !tables.length) {
    const fromUrl = sourceQuery?.get('table');
    if (!fromUrl) throw new Error('Could not discover the Bitable tables. Wait for the table tabs to load in the source tab and try again.');
    tables = [{ id: fromUrl, name: '' }];
    issues.push('The table list could not be read from the page; only the table open in the URL was exported.');
  }

  const title = safeName(hintedTitle || 'Bitable');
  const tablesEvidence = [];
  let truncated = false;
  for (const [index, table] of tables.entries()) {
    const tableId = table.id;
    const tableName = table.name || `table-${tableId}`;
    stage(0.1 + 0.8 * index / tables.length, `Exporting table ${index + 1} of ${tables.length}: ${tableName || tableId}`);
    try {
      const metaPayload = await postJSON(`/space/api/bitable/${appToken}/tablesv3/`, {
        tableIDList: [tableId], tablePartitionFlagList: [0], tablePartitionForNoRankFlagList: [],
        encodingProtocol: { compression: 1, serialization: 0 },
      });
      const tableData = await decodeBitablePayload(metaPayload.data?.[tableId]);
      const fieldMap = tableData.fieldMap || {};
      const viewEntries = Object.entries(tableData.viewMap || {});
      const urlView = sourceQuery?.get('view');
      const view = viewEntries.find(([id]) => id === urlView)
        || viewEntries.find(([, view]) => Number(view.type) === 1)
        || viewEntries[0];
      const viewId = view?.[0] || '';
      const orderedFieldIds = view?.[1]?.property?.fields?.length ? view[1].property.fields : Object.keys(fieldMap);
      const columns = orderedFieldIds.map((fieldId) => ({ id: fieldId, ...(fieldMap[fieldId] || { name: fieldId, type: 0 }) }));
      const revision = String(tableData.meta?.rev ?? 0);

      const rows = [];
      let offset = 0;
      let total = null;
      let complete = true;
      for (let page = 0; page < 40; page++) {
        const query = new URLSearchParams({ tableId, viewId, tableRev: revision, depRev: '{}', viewLazyLoad: 'true', offset: String(offset), limit: '3000', tableID: tableId, viewID: viewId, removeFmlExtra: 'true' });
        const recordsPayload = await json(`/space/api/v1/bitable/${appToken}/records?${query}`);
        const data = await decodeBitablePayload(recordsPayload.data?.records ?? recordsPayload.data);
        total = Number(data.tableRecordNum ?? total);
        const recordIds = (data.groupList || []).flatMap((group) => group.recordIDList || []);
        for (const recordId of recordIds) {
          const cells = data.recordMap?.[recordId] || {};
          rows.push(columns.map((column) => csvCell(bitableValueToText(cells[column.id]?.value, column))));
        }
        offset += recordIds.length;
        if (!recordIds.length || (total !== null && offset >= total)) { complete = total === null || offset >= total; break; }
      }
      if (!complete || (total !== null && offset < total)) {
        truncated = true;
        issues.push(`Table ${tableName}: ${offset}/${total ?? '?'} records retrieved; the CSV may be partial.`);
      }
      const lines = [columns.map((column) => csvCell(column.name)).join(','), ...rows];
      addFile(`tables/${String(index + 1).padStart(2, '0')}-${safeName(tableName || tableId)}.csv`,
        `\uFEFF${lines.join('\r\n')}\r\n`);
      tablesEvidence.push({ table: tableName, tableId, records: rows.length, total: total ?? rows.length, columns: columns.length });
    } catch (error) {
      signal.throwIfAborted();
      issues.push(`Table ${safeName(tableName)}: ${error.message}`);
      tablesEvidence.push({ table: tableName, tableId, failed: true });
    }
  }

  stage(0.95, 'Checking export integrity');
  const failed = tablesEvidence.filter((entry) => entry.failed).length;
  const checks = [
    { name: 'tables', status: failed ? 'fail' : 'pass', detail: `${tablesEvidence.length - failed}/${tablesEvidence.length} data table(s) exported as CSV.` },
    { name: 'records', status: truncated ? 'warn' : 'pass', detail: truncated
      ? 'Some table record lists did not finish paginating.'
      : `All records retrieved (${tablesEvidence.reduce((sum, entry) => sum + (entry.records || 0), 0)} rows in total).` },
  ];
  const verdict = failed ? 'incomplete' : truncated ? 'degraded' : 'complete';
  const integrity = { schemaVersion: 1, verdict, route: 'bitable-csv', checks, evidence: { media: {}, tables: tablesEvidence } };
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    run: { format: 'csv', client: 'chrome-extension', version: '0.2.7' },
    documents: [{ url: url.href, title, output: 'tables/', operationalStatus: failed ? 'partial' : 'success', integrity, issues }],
  };
  addFile('export-report.json', JSON.stringify(report, null, 2));
  addFile('README.txt', `Feishu Grabber — Bitable CSV export\n\nSource: ${url.href}\nExported: ${report.generatedAt}\nIntegrity: ${verdict}\n\nEach data table is one CSV file (UTF-8 with BOM so Excel opens it correctly).\nOpen export-report.json for all checks.\n${issues.length ? '\nIssues:\n' + issues.map((issue) => '- ' + issue).join('\n') : ''}\n`);
  return { title, report };
}

export async function exportDocument({ url: value, transport, captureBoards = true, signal = new AbortController().signal, progress = () => {} }) {
  const url = validateDocumentURL(value);
  const issues = [];
  const files = Object.create(null);
  const encoder = new TextEncoder();
  let totalBytes = 0;
  const addFile = (path, content) => {
    const bytes = typeof content === 'string' ? encoder.encode(content) : content;
    if (totalBytes + bytes.byteLength > 100 * 1024 * 1024) throw new Error('The export exceeds the 100 MB limit.');
    totalBytes += bytes.byteLength;
    files[path] = bytes;
  };
  const stage = (fraction, message) => { signal.throwIfAborted(); progress({ fraction, message }); };
  const request = async (path, options) => {
    signal.throwIfAborted();
    const text = await transport.request(new URL(path, url).href, options);
    signal.throwIfAborted();
    return text;
  };
  const json = async (path, options) => {
    let payload;
    try { payload = JSON.parse(await request(path, options)); }
    catch (error) { signal.throwIfAborted(); throw new Error(error instanceof SyntaxError ? 'Feishu returned a sign-in page or an unreadable response.' : error.message); }
    if (payload.code !== 0) throw new Error(`Feishu request failed (code ${payload.code ?? 'unknown'}): ${String(payload.msg || 'Access unavailable').slice(0, 160)}`);
    return payload;
  };
  const postJSON = (path, body) => json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  stage(0.06, 'Reading document');
  let objToken = url.pathname.startsWith('/docx/') ? url.pathname.split('/')[2] : null;
  let canonical;
  if (url.pathname.startsWith('/wiki/')) {
    try {
      canonical = await json(`/space/api/wiki/v2/tree/get_node/?wiki_token=${url.pathname.split('/')[2]}`);
      objToken = canonical.data?.obj_token || null;
    } catch (error) { signal.throwIfAborted(); issues.push(`Wiki reference: ${error.message}`); }
    // The wiki node API reports obj_type as a name on some tenants and as a
    // numeric code on others (8 = Bitable, 22 = docx document).
    const rawType = String(canonical?.data?.obj_type ?? '').toLowerCase();
    const objType = { 8: 'bitable', 22: 'docx' }[rawType] ?? (/^[a-z]/.test(rawType) ? rawType : `type ${rawType}`);
    if (objType === 'bitable' || (!rawType && url.pathname.startsWith('/base/'))) {
      const { title, report } = await exportBitableCSV({
        url, sourceQuery: new URL(value).searchParams, appToken: objToken || url.pathname.split('/')[2],
        hintedTitle: canonical?.data?.title || '',
        transport, signal, stage, json, postJSON, addFile, issues,
      });
      return { title, files, report, totalBytes };
    }
    if (objType && !['docx', 'docs'].includes(objType)) {
      throw new Error(`This wiki node is a ${objType}, not a document. The extension exports docx documents and Bitable tables only.`);
    }
  }
  const html = await request(url.href);
  const raw = extractClientVars(html);
  if (!raw) throw new Error('Document data is unavailable. Check that this document is fully open and signed in. This preview supports SSR documents; it does not silently export only the visible page.');
  let parsedClientVars;
  try { parsedClientVars = JSON.parse(raw); }
  catch {
    throw new Error('This page does not contain docx document data. Only documents (docx) are supported — Bitable tables, sheets and other node types are not.');
  }
  let data = parsedClientVars?.data;
  if (!data?.block_map || !Object.values(data.block_map).some((block) => block.data?.type === 'page')) {
    throw new Error('The document response has no readable block tree. Check access in the source tab.');
  }
  objToken ||= data.id;
  let pagination = data.has_more === false ? 'complete' : data.has_more === true ? 'truncated' : 'unknown';
  if (data.has_more === true) {
    const initial = data;
    const queue = [...(Array.isArray(data.next_cursors) ? data.next_cursors : [])];
    const seen = new Set();
    const pages = [];
    for (let i = 0; i < queue.length && i < 100; i++) {
      const cursor = queue[i];
      if (seen.has(cursor)) continue;
      seen.add(cursor);
      try {
        stage(0.12, `Reading document page ${pages.length + 2}`);
        const query = new URLSearchParams({ id: initial.id, mode: '7', limit: String(Math.max(1, Object.keys(initial.block_map).length)), cursor });
        const page = (await json(`/space/api/docx/pages/client_vars?${query}`)).data;
        if (!page?.block_map) throw new Error('A document page is missing its block tree.');
        pages.push(page);
        data = mergeClientVarsPages(initial, pages);
        if (Array.isArray(page.next_cursors)) for (const next of page.next_cursors) if (!queue.includes(next)) queue.push(next);
        pagination = page.has_more === false ? 'complete' : page.has_more === true ? 'truncated' : 'unknown';
      } catch (error) { signal.throwIfAborted(); pagination = 'truncated'; issues.push(`Pagination: ${error.message}`); break; }
    }
    if (queue.some((cursor) => !seen.has(cursor))) pagination = 'truncated';
  }
  const parsed = clientVarsDataToMarkdown(data, html);
  if (!parsed?.markdown?.trim()) throw new Error('The document body is empty. No archive was created.');
  const referencedBlocks = new Set(data.block_sequence || []);
  for (const block of Object.values(data.block_map)) {
    for (const child of block.data?.children || []) referencedBlocks.add(child);
    for (const cell of Object.values(block.data?.cell_set || {})) if (cell?.block_id) referencedBlocks.add(cell.block_id);
  }
  const missingBlocks = [...referencedBlocks].filter((id) => !data.block_map[id]);
  if (missingBlocks.length) issues.push(`${missingBlocks.length} document section(s) were declared by Feishu but were not returned.`);
  const title = safeName(parsed.title || /<title>([^<]+)<\/title>/.exec(html)?.[1]?.replace(/ - (飞书云文档|Feishu Docs|飞书)$/, '') || 'Untitled');
  const parts = parsed.blocks;
  const structuredSheets = [];
  let sheetFallbacks = [...parsed.sheets];

  stage(0.25, 'Processing tables');
  for (const item of parsed.sheets) {
    try {
      const ref = parseEmbeddedSheetRef(item.token);
      let sheetId = ref.sheetId;
      if (!sheetId) {
        const resource = await postJSON('/space/api/v3/sheet/resource/', { path: ['comments'], token: ref.token, sheetIDs: [] });
        const ids = Object.keys(resource.data?.resource || {});
        if (ids.length !== 1) throw new Error('Could not identify the embedded sheet.');
        sheetId = ids[0];
      }
      const payload = await postJSON('/space/api/v3/sheet/client_vars', { memberId: 0, schemaVersion: 9, openType: 1, token: ref.token, sheetRange: { sheetId }, clientVersion: 'v0.0.1' });
      if (payload.data?.token !== ref.token) throw new Error('The sheet response does not match this document.');
      const formulaPayloads = [];
      for (const blockId of sheetBlockRequirements(payload).formulaBlockIds) {
        const query = new URLSearchParams({ token: ref.token, block_token: blockId, blockIds: blockId });
        formulaPayloads.push(await json(`/space/api/v3/sheet/formula/data_block?${query}`));
      }
      const sheet = decodeSheetClientVars(payload, formulaPayloads);
      if (!sheet.structuredComplete) throw new Error('Some sheet cells or formula values are missing.');
      const placeholder = `![Table](ssrsheet://${item.token}/${item.blockId})`;
      const part = parts.find((entry) => entry.id === item.blockId);
      if (part && !part.md.includes(placeholder)) part.md = sheet.markdown;
      else for (const entry of parts) entry.md = entry.md.split(placeholder).join(sheet.markdown);
      const { markdown, token, ...sidecar } = sheet;
      addFile(`assets/sheet-${structuredSheets.length + 1}.json`, JSON.stringify(sidecar, null, 2));
      structuredSheets.push(sheet);
      sheetFallbacks = sheetFallbacks.filter((entry) => entry.token !== item.token);
    } catch (error) { signal.throwIfAborted(); issues.push(`Embedded sheet: ${error.message}`); }
  }

  stage(0.4, 'Reading comments');
  let threads = [];
  let commentStatus = 'unknown';
  let commentError;
  if (objToken) {
    try {
      const options = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } };
      const idsPayload = await json(`/space/api/comment/commentid/all?obj_type=22&token=${encodeURIComponent(objToken)}&comment_type_list=0&comment_type_list=1&need_comment_relations=true`, options);
      const ids = collectCommentIds(idsPayload.data);
      if (ids.length) {
        const body = new URLSearchParams({ obj_type: '22', token: objToken, need_reply: 'true', need_reaction: 'true', no_need_comment_relations: 'true', need_msg_box_version: 'true' });
        ids.forEach((id) => body.append('comment_ids', id));
        const batch = await json('/space/api/comment/batch', { ...options, body: body.toString() });
        threads = normalizeCommentThreads(idsPayload.data, batch.data);
        if (ids.some((id) => !threads.some((thread) => thread.id === id) && !((batch.data?.comments ?? batch.data)?.[id]?.delete_flag))) {
          throw new Error('Some comment threads were not returned.');
        }
      }
      commentStatus = 'checked';
    } catch (error) { signal.throwIfAborted(); commentStatus = 'failed'; commentError = error.message; issues.push(`Comments: ${commentError}`); }
  }
  const pageId = Object.entries(data.block_map).find(([, block]) => block.data?.type === 'page')?.[0];
  threads.forEach((thread, index) => {
    let current = thread.blockId;
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      const parent = data.block_map[current]?.data?.parent_id;
      if (!parent || parent === pageId) break;
      current = parent;
    }
    const part = parts.find((entry) => entry.id === current);
    if (part) part.md += ` ⟦REF${index}⟧`;
  });
  let body = parts.map((part) => part.md).join('\n\n');
  let images = 0, attachments = 0;
  const streamHost = /(^|\.)feishu\.cn$/.test(url.hostname) ? 'internal-api-drive-stream.feishu.cn' : 'internal-api-drive-stream.larksuite.com';
  const resources = [...parsed.images.map((item) => ({ ...item, kind: 'image' })), ...parsed.files.map((item) => ({ ...item, kind: 'file' }))];
  for (const [index, item] of resources.entries()) {
    stage(0.5 + 0.35 * index / Math.max(1, resources.length), `Saving resource ${index + 1} of ${resources.length}`);
    const marker = `${item.kind === 'image' ? 'ssrimg' : 'ssrfile'}://${item.token}/${item.blockId}`;
    try {
      const query = new URLSearchParams({ mount_node_token: item.blockId, mount_point: item.kind === 'image' ? 'docx_image' : 'docx_file', policy: 'equal', preview_type: '16' });
      const result = await transport.media(`https://${streamHost}/space/api/box/stream/download/preview/${encodeURIComponent(item.token)}/?${query}`);
      signal.throwIfAborted();
      const { extension } = validateDownloadedPayload(result.bytes, { kind: item.kind, contentType: result.contentType });
      const path = item.kind === 'image' ? `assets/image-${images + 1}.${extension}` : `attachments/${attachments + 1}-${safeName(item.name)}`;
      addFile(path, result.bytes);
      body = body.split(marker).join(path.split('/').map(encodeURIComponent).join('/'));
      if (item.kind === 'image') images++; else attachments++;
    } catch (error) {
      signal.throwIfAborted();
      issues.push(`${item.kind === 'image' ? 'Image' : 'Attachment'} ${safeName(item.name)}: ${error.message}`);
      body = body.split(marker).join('#missing-resource');
    }
  }
  let boardsExported = 0;
  const boardCaptures = [];
  if (parsed.whiteboards.length && !captureBoards) {
    issues.push('Whiteboard screenshots are disabled in settings; boards are marked as missing.');
  }
  for (const [index, item] of parsed.whiteboards.entries()) {
    if (!captureBoards) break;
    stage(0.5 + 0.35 + (0.03 * index) / Math.max(1, parsed.whiteboards.length), `Capturing whiteboard ${index + 1} of ${parsed.whiteboards.length}`);
    const marker = `ssrboard://${item.token}/${item.blockId}`;
    try {
      const shot = await transport.capture({ blockId: item.blockId, token: item.token, index });
      signal.throwIfAborted();
      const { extension } = validateDownloadedPayload(shot.bytes, { kind: 'image', contentType: 'image/png' });
      const path = `assets/board-${boardsExported + 1}.${extension}`;
      addFile(path, shot.bytes);
      body = body.split(marker).join(path.split('/').map(encodeURIComponent).join('/'));
      boardsExported++;
      boardCaptures.push({ blockId: item.blockId, route: shot.route, width: shot.width, height: shot.height, sha256: shot.sha256 });
    } catch (error) {
      signal.throwIfAborted();
      issues.push(`Whiteboard ${index + 1}: ${error.message}`);
    }
  }
  body = body.replace(/!\[(Whiteboard|Table)\]\((?:ssrboard|ssrsheet):\/\/[^)]+\)/g, '> $1 was not exported. View this content in the original document.');
  body = renderMarkdownImagesInHtmlTables(applyComments(body, threads));
  stage(0.9, 'Checking export integrity');
  const integrity = evaluateIntegrity({
    route: 'extension-ssr', bodyPresent: Boolean(body.trim()), pagination,
    media: {
      images: { expected: parsed.images.length, exported: images }, attachments: { expected: parsed.files.length, exported: attachments },
      whiteboards: { expected: parsed.whiteboards.length, exported: boardsExported }, sheetFallbacks: { expected: sheetFallbacks.length, exported: 0 },
      structuredSheets: { expected: parsed.sheets.length, exported: structuredSheets.length, formulaExpressionsMissing: structuredSheets.reduce((sum, sheet) => sum + sheet.formulaExpressionsMissing, 0), mergedRanges: structuredSheets.reduce((sum, sheet) => sum + sheet.merges.length, 0) },
    },
    comments: { status: commentStatus, error: commentError, ...commentStats(threads) },
    unknownBlocks: parsed.stats.unknownBlocks, blocks: parsed.stats.blocks, blockTypes: parsed.stats.types,
    renderability: { status: 'checked', markdownImagesInHtmlTables: countMarkdownImagesInHtmlTables(body) },
  });
  integrity.checks.push({ name: 'block_structure', status: missingBlocks.length ? 'fail' : 'pass', detail: missingBlocks.length ? `${missingBlocks.length} document section(s) are missing from the source response.` : 'All referenced document sections were retrieved.' });
  integrity.evidence.missingBlocks = missingBlocks.length;
  integrity.evidence.boardCaptures = boardCaptures;
  if (missingBlocks.length) integrity.verdict = 'incomplete';
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), run: { format: 'md', client: 'chrome-extension', version: '0.1.0' }, documents: [{ url: url.href, title, output: `${title}.md`, operationalStatus: 'success', integrity, issues }] };
  addFile(`${title}.md`, `# ${title}\n\n${body}\n`);
  addFile('export-report.json', JSON.stringify(report, null, 2));
  addFile('README.txt', `Feishu Grabber\n\nSource: ${url.href}\nExported: ${report.generatedAt}\nIntegrity: ${integrity.verdict}\n\nKeep this folder together so images and attachments remain available.\nOpen export-report.json for all checks.\n${issues.length ? '\nIssues:\n' + issues.map((issue) => '- ' + issue).join('\n') : ''}\n`);
  stage(0.95, 'Preparing download');
  return { title, files, report, totalBytes };
}
