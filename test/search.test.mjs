import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { DailyChrome, allowedRequest, workspaceURL } from '../lib/daily-chrome.mjs';
import { parseSearchResults, plainText, searchURL } from '../lib/search.mjs';

const home = 'https://example.feishu.cn/drive/home/';
const document = 'https://example.feishu.cn/docx/Document';

function pageBrowser({ fetch, url = home, tabs = [url] } = {}) {
  const entries = tabs.map((tabURL, index) => ({ id: 1000 + index, url: tabURL }));
  const scripts = [];
  const context = vm.createContext({
    location: { href: url }, document: { readyState: 'complete' },
    fetch, AbortController, Uint8Array, setTimeout, clearTimeout,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  });
  const run = async (script) => {
    scripts.push(script);
    if (script.includes('set rows to')) return entries.map((entry) => `1\t${entry.id}\t${entry.url}`).join('\n');
    if (script.includes('make new tab')) {
      const entry = { id: 2000 + entries.length, url };
      entries.push(entry);
      return String(entry.id);
    }
    const match = /execute t javascript ("(?:\\.|[^"\\])*")/.exec(script);
    assert.ok(match, 'Only documented Chrome JavaScript calls should reach the fake page');
    return String(vm.runInContext(JSON.parse(match[1]), context));
  };
  return { browser: new DailyChrome({ run, timeoutMs: 2000 }), context, scripts };
}

test('workspace pages are accepted while document and foreign links are not', () => {
  assert.equal(workspaceURL(home).href, home);
  assert.equal(workspaceURL('https://example.feishu.cn/').href, 'https://example.feishu.cn/');
  assert.throws(() => workspaceURL(document), /workspace page/);
  assert.throws(() => workspaceURL('https://example.com/drive/home/'), /workspace page/);
  assert.throws(() => workspaceURL('http://example.feishu.cn/drive/home/'), /workspace page/);
});

test('the search endpoint is the only search request allowed, from either page kind', () => {
  const endpoint = 'https://example.feishu.cn/space/api/search/search_wiki/?query=q&offset=0&count=20';
  assert.equal(allowedRequest(home, endpoint), true);
  assert.equal(allowedRequest(document, endpoint), true);
  assert.equal(allowedRequest(home, endpoint, 'POST'), false);
  assert.equal(allowedRequest(home, 'https://other.feishu.cn/space/api/search/search_wiki/?query=q'), false);
  assert.equal(allowedRequest(home, 'https://example.feishu.cn/space/api/search/delete_search_history/?query=q'), false);
  assert.equal(allowedRequest(home, 'https://example.feishu.cn/space/api/docx/delete'), false);
});

test('search URLs carry an encoded query and paging', () => {
  const url = new URL(searchURL(home, { query: '会议 & 测试', offset: 20, count: 5 }));
  assert.equal(url.pathname, '/space/api/search/search_wiki/');
  assert.equal(url.searchParams.get('query'), '会议 & 测试');
  assert.equal(url.searchParams.get('offset'), '20');
  assert.equal(url.searchParams.get('count'), '5');
});

test('highlighted titles and previews are returned as plain text', () => {
  assert.equal(plainText('7月<em>会议</em> &amp; &lt;纪要&gt;'), '7月会议 & <纪要>');
});

test('results prefer the wiki link and fall back to the document type', () => {
  const payload = { data: { total: 2, has_more: true, entities: { objs: {
    a: { token: 'WIKITOKEN', type: 22, title: '7月<em>会议</em>', preview: 'a &amp; b', edit_time: '1700000000', edit_name: '示例成员', wiki_infos: [{ wiki_url: 'https://example.feishu.cn/wiki/WIKITOKEN', space_name: '研发部' }] },
    b: { token: 'DOCTOKEN', type: 22, title: '其他', preview: '', url: '', wiki_infos: [] },
  } } } };
  const result = parseSearchResults(payload, 'https://example.feishu.cn');
  assert.equal(result.total, 2);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.items.map((item) => item.url), [
    'https://example.feishu.cn/wiki/WIKITOKEN',
    'https://example.feishu.cn/docx/DOCTOKEN',
  ]);
  assert.equal(result.items[0].title, '7月会议');
  assert.equal(result.items[0].preview, 'a & b');
  assert.equal(result.items[0].space, '研发部');
  assert.equal(result.items[0].author, '示例成员');
  assert.equal(result.items[0].editedAt, new Date(1700000000 * 1000).toISOString());
});

test('search runs from a workspace tab and parses the response', async () => {
  let requested;
  const { browser } = pageBrowser({ fetch: async (url) => {
    requested = new URL(url);
    const response = new Response(JSON.stringify({ code: 0, data: { total: 1, has_more: false, entities: { objs: {
      x: { token: 'TOKEN', type: 22, title: '会议纪要', wiki_infos: [] },
    } } } }));
    Object.defineProperty(response, 'url', { value: url });
    return response;
  } });
  await browser.prepareWorkspace(home);
  const result = await browser.search('  测试  ');
  assert.equal(requested.pathname, '/space/api/search/search_wiki/');
  assert.equal(requested.searchParams.get('query'), '测试');
  assert.equal(requested.searchParams.get('count'), '20');
  assert.deepEqual(result.items.map((item) => item.title), ['会议纪要']);
});

test('search never opens a window when no Feishu tab is available', async () => {
  const { browser, scripts } = pageBrowser({ fetch: async () => { throw new Error('must not fetch'); }, tabs: ['https://example.com/'] });
  await assert.rejects(browser.prepareWorkspace(home), /never open a page/);
  assert.equal(scripts.some((script) => script.includes('make new window') || script.includes('make new tab')), false);
});

test('search reuses an open Feishu tab instead of opening a page', async () => {
  const openDocument = 'https://example.feishu.cn/docx/AlreadyOpen';
  let requested;
  const { browser, scripts } = pageBrowser({
    url: openDocument,
    tabs: ['https://example.com/', openDocument],
    fetch: async (url) => {
      requested = new URL(url);
      const response = new Response(JSON.stringify({ code: 0, data: { total: 0, has_more: false, entities: { objs: {} } } }));
      Object.defineProperty(response, 'url', { value: url });
      return response;
    },
  });
  await browser.prepareWorkspace(home);
  await browser.search('会议');
  assert.equal(requested.origin, 'https://example.feishu.cn');
  assert.equal(scripts.some((script) => script.includes('make new tab')), false);
});

test('search rejects an empty query and an invalid page size', async () => {
  const { browser } = pageBrowser({ fetch: async () => { throw new Error('must not fetch'); } });
  await browser.prepareWorkspace(home);
  await assert.rejects(browser.search('   '), /Provide a search query/);
  await assert.rejects(browser.search('测试', { count: 0 }), /between 1 and 100/);
});
