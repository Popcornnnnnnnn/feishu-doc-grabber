import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { BrowserOS, parseTabs, readDocumentWithBrowserOS, searchWithBrowserOS, unwrap, unwrapText } from '../lib/browseros.mjs';
import { searchURL } from '../lib/search.mjs';

const payload = JSON.stringify({ code: 0, data: { total: 1, has_more: false, entities: { objs: {
  a: { token: 'TOKEN', type: 22, title: '会议纪要', wiki_infos: [] },
} } } });

function fakeClient({ tabs = [], opened = 1720, page = payload, readResult = '[UNTRUSTED_PAGE_CONTENT nonce=1 origin=https://x]\n# Title\nBody\n[END_UNTRUSTED_PAGE_CONTENT nonce=1]' } = {}) {
  const calls = [];
  return {
    calls,
    async initialize() {},
    async tabs() { return tabs; },
    async openTab(url) { calls.push(['open', url]); return { id: opened, url }; },
    async closeTab(id) { calls.push(['close', id]); return 'closed'; },
    async readPage(id, url) { calls.push(['read', id, url]); return page; },
    async callTool(name, args) { calls.push(['tool', name, args]); return readResult; },
  };
}

test('the tab list is parsed into ids and URLs', () => {
  const tabs = parseTabs('User\'s tabs:\n[1718] https://example.feishu.cn/drive/home/ (主页)\n[428] https://www.toutiao.com/ (今日头条) [group X]\n');
  assert.deepEqual(tabs, [
    { id: 1718, url: 'https://example.feishu.cn/drive/home/' },
    { id: 428, url: 'https://www.toutiao.com/' },
  ]);
});

test('the untrusted-content banner is stripped and missing payloads are rejected', () => {
  assert.match(unwrap(`[UNTRUSTED_PAGE_CONTENT nonce=1 origin=https://x] banner\n${payload}\n[END]`), /^\{.*\}$/);
  assert.throws(() => unwrap('no payload here'), /no result payload/);
});

test('search reuses an existing Feishu tab and pages through it', async () => {
  const client = fakeClient({ tabs: [
    { id: 428, url: 'https://www.toutiao.com/' },
    { id: 1718, url: 'https://example.feishu.cn/drive/home/' },
  ] });
  const { payload: body, url } = await searchWithBrowserOS('会议', { count: 5, offset: 10 }, { client, searchURL });
  assert.equal(JSON.parse(body).data.total, 1);
  assert.equal(url, 'https://example.feishu.cn/space/api/search/search_wiki/?query=%E4%BC%9A%E8%AE%AE&offset=10&count=5');
  assert.deepEqual(client.calls, [['read', 1718, url]]);
});

test('a Feishu tab is opened only when none exists', async () => {
  const client = fakeClient({ tabs: [{ id: 1, url: 'https://example.com/' }] });
  const { url } = await searchWithBrowserOS('会议', { site: 'https://example.feishu.cn/drive/home/' }, { client, searchURL });
  assert.deepEqual(client.calls[0], ['open', 'https://example.feishu.cn/drive/home/']);
  assert.equal(new URL(url).origin, 'https://example.feishu.cn');
});

test('search fails clearly when no tenant is known', async () => {
  const client = fakeClient({ tabs: [{ id: 1, url: 'https://example.com/' }] });
  await assert.rejects(searchWithBrowserOS('会议', {}, { client, searchURL }), /Open a Feishu page in BrowserOS/);
});

test('the MCP client exchanges JSON-RPC over the streamable endpoint', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const headers = { 'mcp-session-id': 'session-1', 'content-type': 'text/event-stream' };
    const result = body.method === 'initialize'
      ? { protocolVersion: '2025-06-18', serverInfo: { name: 'browseros-neo' } }
      : body.method === 'tools/call'
        ? { content: [{ type: 'text', text: '[1718] https://example.feishu.cn/drive/home/ (主页)' }] }
        : {};
    return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, { status: 200, headers });
  };
  const client = new BrowserOS({ fetchImpl });
  const initialized = await client.initialize();
  assert.equal(initialized.serverInfo.name, 'browseros-neo');
  assert.equal(client.session, 'session-1');
  assert.match(await client.callTool('tabs', { action: 'list' }), /1718/);
  assert.equal(requests[1].method, 'notifications/initialized');
  assert.equal(requests[2].params.name, 'tabs');
});

test('tool errors surface as failures', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const payload = body.method === 'initialize'
      ? { result: { serverInfo: { name: 'browseros-neo' } } }
      : { result: { content: [{ type: 'text', text: 'browser session not connected' }], isError: true } };
    return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload })}\n\n`, { status: 200 });
  };
  const client = new BrowserOS({ fetchImpl });
  await client.initialize();
  await assert.rejects(client.callTool('tabs', { action: 'list' }), /browser session not connected/);
});

test('unwrapText strips the untrusted-content wrapper', () => {
  assert.equal(unwrapText('[UNTRUSTED_PAGE_CONTENT nonce=1 origin=https://x]\n# Hello\nWorld\n[END_UNTRUSTED_PAGE_CONTENT nonce=1]'), '# Hello\nWorld');
});

test('readDocumentWithBrowserOS opens a temporary tab, reads markdown, and closes it', async () => {
  const client = fakeClient({ tabs: [] });
  const text = await readDocumentWithBrowserOS('https://example.feishu.cn/wiki/ABC', {}, { client, available: async () => true });
  assert.equal(text, '# Title\nBody');
  assert.deepEqual(client.calls, [
    ['open', 'https://example.feishu.cn/wiki/ABC'],
    ['tool', 'read', { page: 1720, format: 'markdown' }],
    ['close', 1720],
  ]);
});

test('readDocumentWithBrowserOS reuses an existing tab without closing it', async () => {
  const url = 'https://example.feishu.cn/wiki/ABC';
  const client = fakeClient({ tabs: [{ id: 1719, url }] });
  const text = await readDocumentWithBrowserOS(url, { format: 'text' }, { client, available: async () => true });
  assert.equal(text, '# Title\nBody');
  assert.deepEqual(client.calls, [
    ['tool', 'read', { page: 1719, format: 'text' }],
  ]);
});

const SHEET_CELL_BLOCK = 'H4sIAAAAAAAAA62RwUrDQBCGZ3fTdFlSWFYPcQVZctBYWMhGoSGnpulWCwlIkr6Ad9/AR/DgI9ibHvoGnr0IXvUJpG+haBrtyZPf5ZuZf2AOw94IJeKZUO/yiTBOgYPvKW/oTq4uTByJFWI+tIxb0Y13xwLPp+Jovbx/v3tULw9qvbxR16o+t7bRuS0KPc2aTE9indjTXAxKW51ZbU2kZ8YI0e412bzQhYn1yWg0dL7OxwcUSVwZ2Z+l9aJMTdDL60UZBrgyAc6P0322x3BlxA4F/tGBfKIgAQnBIXM4hMAcjkKQroIQkoFkHHxo69jhWOH4FbFbhGALTJzfprcVuPBf9P+OqQDhUsIhao0iJFyKOURIUOpw8LtJZ/xt8mMSIbn53ScTFQDz2wEAAA==';
const SHEET_BLOCK_META = 'H4sIAAAAAAAAA52Ry27DIBBF/2XWLABjjFlGbaUuKlWK1E1lWZTgBBWbCpw+YvHvlR9KmrSLqDvmDszccxlg1T4SikEOoI1zK+f164PpVQT5PEAw7zZa34GkAkFQ3daMN4P/WPcq9CAxGovbbgOSZAi0d6eG9m5qlCwheBkH329Azqe64IKRLC9pmXPBacFZVhMhBMaUE15TAQiiPRiQrMgRbA/2bT2VGSapQtD40O6dOvodbUW9M616MmG2zCi6ANipeDe/A9mHvZmUGxv6r6PcKBcNglZ9LtLomSz+T8FchUMyIVguRDnjtLY7n/lryQxM8U9ehlOVEgKSY940f/7Tf+Ig9DyOhfu6PPBFHlVK6RsvT3RmSgIAAA==';
const SHEET_FORMULA_BLOCK = 'H4sIAAAAAAAAA6tWMlSyqlYqUbIy0lEqU7IyNKitBQAlc/I2FAAAAA==';
const SHEET_CELL_BLOCK_ID = 'block_7684135929568627643_1888002616_28';
const SHEET_FORMULA_BLOCK_ID = 'block_7684135929568627643_1138845889_28';

test('readDocumentWithBrowserOS decodes a wiki Sheet without opening a new tab when a Feishu tab exists', async () => {
  const client = fakeClient({ tabs: [{ id: 1718, url: 'https://example.feishu.cn/drive/home/' }] });
  client.fetchJson = async (pageId, requestURL, opts) => {
    client.calls.push(['fetchJson', pageId, requestURL, opts?.method ?? 'GET']);
    if (requestURL.includes('/wiki/v2/tree/get_node/')) {
      return { ok: true, status: 200, data: { code: 0, data: { obj_type: 3, obj_token: 'SHT_TOKEN', title: '账密记录' } } };
    }
    if (requestURL.includes('/v3/sheet/resource/')) {
      return { ok: true, status: 200, data: { code: 0, data: { resource: { BmP120: {} } } } };
    }
    if (requestURL.includes('/v3/sheet/client_vars')) {
      return {
        ok: true, status: 200,
        data: {
          code: 0,
          data: {
            token: 'SHT_TOKEN', sheetId: 'BmP120', revision: 28,
            snapshot: { gzipBlockMeta: SHEET_BLOCK_META, blocks: { [SHEET_CELL_BLOCK_ID]: SHEET_CELL_BLOCK } },
          },
        },
      };
    }
    if (requestURL.includes('/v3/sheet/formula/data_block')) {
      return { ok: true, status: 200, data: { code: 0, data: { blocks: { [SHEET_FORMULA_BLOCK_ID]: SHEET_FORMULA_BLOCK } } } };
    }
    throw new Error(`Unexpected URL: ${requestURL}`);
  };

  const md = await readDocumentWithBrowserOS('https://example.feishu.cn/wiki/WIKI_SHT', {}, { client, available: async () => true });
  assert.match(md, /^# 账密记录/);
  assert.match(md, /<table data-feishu-sheet-id="BmP120">/);
  assert.match(md, /SHEET-CELL-DATA-B2-8E4C/);
  assert.match(md, /data-formula-expression="=SUM\(C2:C4\)">10<\/td>/);
  assert.equal(client.calls.some(([kind]) => kind === 'open'), false);
});

test('readDocumentWithBrowserOS decodes an already-open wiki Sheet via API instead of reading viewer chrome', async () => {
  const url = 'https://example.feishu.cn/wiki/WIKI_SHT';
  const client = fakeClient({
    tabs: [{ id: 1718, url }],
    readResult: '[UNTRUSTED_PAGE_CONTENT nonce=1 origin=https://x]\nToolbar Chrome\n[END_UNTRUSTED_PAGE_CONTENT nonce=1]',
  });
  client.fetchJson = async (pageId, requestURL) => {
    client.calls.push(['fetchJson', pageId, requestURL]);
    if (requestURL.includes('/wiki/v2/tree/get_node/')) {
      return { ok: true, status: 200, data: { code: 0, data: { obj_type: 3, obj_token: 'SHT_TOKEN', title: '账密记录' } } };
    }
    if (requestURL.includes('/v3/sheet/resource/')) {
      return { ok: true, status: 200, data: { code: 0, data: { resource: { BmP120: {} } } } };
    }
    if (requestURL.includes('/v3/sheet/client_vars')) {
      return {
        ok: true, status: 200,
        data: {
          code: 0,
          data: {
            token: 'SHT_TOKEN', sheetId: 'BmP120', revision: 28,
            snapshot: { gzipBlockMeta: SHEET_BLOCK_META, blocks: { [SHEET_CELL_BLOCK_ID]: SHEET_CELL_BLOCK } },
          },
        },
      };
    }
    return { ok: true, status: 200, data: { code: 0, data: { blocks: { [SHEET_FORMULA_BLOCK_ID]: SHEET_FORMULA_BLOCK } } } };
  };
  const md = await readDocumentWithBrowserOS(url, {}, { client, available: async () => true });
  assert.match(md, /^# 账密记录/);
  assert.match(md, /SHEET-CELL-DATA-B2-8E4C/);
  assert.equal(client.calls.some(([kind]) => kind === 'tool'), false);
});

test('readDocumentWithBrowserOS extracts a wiki .docx file attachment in the background', async () => {
  const docxBytes = zipSync({
    'word/document.xml': new TextEncoder().encode('<w:document><w:body><w:p><w:r><w:t>产品手册正文</w:t></w:r></w:p></w:body></w:document>'),
  });
  const client = fakeClient({ tabs: [{ id: 1718, url: 'https://example.feishu.cn/drive/home/' }] });
  client.fetchJson = async (pageId, requestURL) => {
    client.calls.push(['fetchJson', pageId, requestURL]);
    return {
      ok: true, status: 200,
      data: {
        code: 0,
        data: {
          obj_type: 12, obj_token: 'FILE_TOK', title: '手册.docx',
          icon_info: JSON.stringify({ file_type: 'docx' }),
        },
      },
    };
  };
  client.downloadBinary = async (pageId, requestURL) => {
    client.calls.push(['downloadBinary', pageId, requestURL]);
    return { bytes: docxBytes, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  };

  const md = await readDocumentWithBrowserOS('https://example.feishu.cn/wiki/WIKI_FILE', {}, { client, available: async () => true });
  assert.equal(md, '# 手册.docx\n\n产品手册正文');
  assert.equal(client.calls.some(([kind]) => kind === 'open'), false);
  assert.match(client.calls[1][2], /internal-api-drive-stream\.feishu\.cn\/space\/api\/box\/stream\/download\/preview\/FILE_TOK/);
});

test('readDocumentWithBrowserOS handles direct /sheets/ and /file/ links when no Feishu tab is open', async () => {
  const client = fakeClient({ tabs: [] });
  client.fetchJson = async (pageId, requestURL) => {
    if (requestURL.includes('/v3/sheet/resource/')) {
      return { ok: true, status: 200, data: { code: 0, data: { resource: { BmP120: {} } } } };
    }
    if (requestURL.includes('/v3/sheet/client_vars')) {
      return {
        ok: true, status: 200,
        data: {
          code: 0,
          data: {
            token: 'SHT1', sheetId: 'BmP120', revision: 28,
            snapshot: { gzipBlockMeta: SHEET_BLOCK_META, blocks: { [SHEET_CELL_BLOCK_ID]: SHEET_CELL_BLOCK } },
          },
        },
      };
    }
    return { ok: true, status: 200, data: { code: 0, data: { blocks: { [SHEET_FORMULA_BLOCK_ID]: SHEET_FORMULA_BLOCK } } } };
  };

  const text = await readDocumentWithBrowserOS('https://example.feishu.cn/sheets/SHT1', { format: 'text' }, { client, available: async () => true });
  assert.match(text, /ID/);
  assert.match(text, /SHEET-CELL-DATA-B2-8E4C/);
  assert.deepEqual(client.calls[0], ['open', 'https://example.feishu.cn/drive/home/']);
  assert.deepEqual(client.calls[client.calls.length - 1], ['close', 1720]);

  const fileClient = fakeClient({ tabs: [{ id: 1718, url: 'https://example.feishu.cn/drive/home/' }] });
  fileClient.downloadBinary = async (_pageId, requestURL) => {
    if (requestURL.includes('/preview/')) {
      const err = new Error('HTTP 404');
      err.status = 404;
      throw err;
    }
    return { bytes: new TextEncoder().encode('hello plain file'), contentType: 'text/plain' };
  };
  const fileText = await readDocumentWithBrowserOS('https://example.feishu.cn/file/FILE2', {}, { client: fileClient, available: async () => true });
  assert.equal(fileText, 'hello plain file');
});

test('BrowserOS.downloadBinary transfers chunked base64 and cleans up page state', async () => {
  const payload = Buffer.from('hello world from feishu attachment');
  const b64 = payload.toString('base64');
  const calls = [];
  const client = new BrowserOS();
  client.callTool = async (name, args) => {
    calls.push([name, args.func]);
    if (args.func.includes('__feishuDownloads.set')) {
      return JSON.stringify({ id: 'dl1', size: payload.length, b64Length: b64.length, contentType: 'text/plain' });
    }
    if (args.func.includes('.slice(')) {
      return b64;
    }
    return 'ok';
  };
  const res = await client.downloadBinary(1718, 'https://internal-api-drive-stream.feishu.cn/test');
  assert.equal(Buffer.from(res.bytes).toString('utf8'), 'hello world from feishu attachment');
  assert.equal(res.contentType, 'text/plain');
  assert.equal(calls.length, 3);
  assert.match(calls[2][1], /__feishuDownloads\?\.delete/);
});

test('searchWithBrowserOS prefers a drive home tab over a temporary wiki tab', async () => {
  const client = fakeClient({ tabs: [
    { id: 1751, url: 'https://example.feishu.cn/wiki/TEMP' },
    { id: 1729, url: 'https://example.feishu.cn/drive/home/' },
  ] });
  await searchWithBrowserOS('会议', { count: 5 }, { client, searchURL });
  assert.equal(client.calls[0][1], 1729);
});

test('searchWithBrowserOS retries on a fresh tab when a concurrent tab closes', async () => {
  let tabCalls = 0;
  let readCalls = 0;
  const client = {
    async initialize() {},
    async tabs() {
      tabCalls += 1;
      return tabCalls === 1
        ? [{ id: 1751, url: 'https://example.feishu.cn/wiki/CLOSING' }]
        : [{ id: 1729, url: 'https://example.feishu.cn/drive/home/' }];
    },
    async openTab(url) { return { id: 1799, url }; },
    async readPage(id) {
      readCalls += 1;
      if (id === 1751) throw new Error('evaluate_in_page failed: Unknown page 1751');
      return payload;
    },
  };
  const { payload: body } = await searchWithBrowserOS('会议', {}, { client, searchURL });
  assert.equal(readCalls, 2);
  assert.equal(JSON.parse(body).data.total, 1);
});

test('readDocumentWithBrowserOS reads docx/wiki via SSR without opening a new tab', async () => {
  const clientVars = {
    block_map: {
      page1: { id: 'page1', data: { type: 'page', children: ['b1'], text: { initialAttributedTexts: { text: { 0: '环境说明' } } } } },
      b1: { id: 'b1', data: { type: 'text', text: { initialAttributedTexts: { text: { 0: '106 测试环境地址' } } } } },
    },
    meta_map: { page1: { title: '环境说明' } },
  };
  const ssrHtml = `<html><script>window.DATA = { clientVars: Object(${JSON.stringify(clientVars)}) };</script></html>`;
  const client = fakeClient({
    tabs: [{ id: 1729, url: 'https://example.feishu.cn/drive/home/' }],
    page: `[UNTRUSTED_PAGE_CONTENT nonce=1 origin=https://x]\n${ssrHtml}\n[END_UNTRUSTED_PAGE_CONTENT nonce=1]`,
  });
  client.fetchJson = async () => ({ ok: true, status: 200, data: { code: 0, data: { obj_type: 22, obj_token: 'DOC1', title: '环境说明' } } });

  const md = await readDocumentWithBrowserOS('https://example.feishu.cn/wiki/WIKI_DOC', {}, { client, available: async () => true });
  assert.match(md, /环境说明/);
  assert.match(md, /106 测试环境地址/);
  assert.equal(client.calls.some(([kind]) => kind === 'open'), false);
});

test('readDocumentWithBrowserOS waits for hydration when initial read is empty', async () => {
  let readCount = 0;
  const client = {
    calls: [],
    async initialize() {},
    async tabs() { return []; },
    async openTab(url) { this.calls.push(['open', url]); return { id: 1760, url }; },
    async closeTab(id) { this.calls.push(['close', id]); return 'closed'; },
    async callTool(name, args) {
      this.calls.push(['tool', name, args]);
      if (name === 'read') {
        readCount += 1;
        return readCount === 1
          ? '[UNTRUSTED_PAGE_CONTENT nonce=1 origin=https://x]\n加载中...\n[END_UNTRUSTED_PAGE_CONTENT nonce=1]'
          : '[UNTRUSTED_PAGE_CONTENT nonce=1 origin=https://x]\n# 正文标题\n加载完成\n[END_UNTRUSTED_PAGE_CONTENT nonce=1]';
      }
      return 'ready';
    },
  };
  const md = await readDocumentWithBrowserOS('https://example.feishu.cn/wiki/SLOW', {}, { client, available: async () => true });
  assert.equal(readCount, 2);
  assert.match(md, /正文标题/);
});
