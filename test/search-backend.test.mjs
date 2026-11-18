import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.FEISHU_GRAB_STATE = join(mkdtempSync(join(tmpdir(), 'feishu-grab-backend-')), 'state.json');
const { searchKnowledgeBase } = await import('../lib/search-backend.mjs');

const payload = JSON.stringify({ code: 0, data: { total: 1, has_more: false, entities: { objs: {
  a: { token: 'TOKEN', type: 22, title: '会议纪要', wiki_infos: [] },
} } } });

test('BrowserOS is preferred so everyday Chrome is untouched', async () => {
  const calls = [];
  const { result, backend } = await searchKnowledgeBase('会议', {}, {
    available: async () => true,
    browserOSSearch: async (query, options) => {
      calls.push({ query, options });
      return { payload, url: 'https://example.feishu.cn/space/api/search/search_wiki/?query=x' };
    },
  });
  assert.equal(backend, 'browseros');
  assert.equal(result.items[0].title, '会议纪要');
  assert.deepEqual(calls, [{ query: '会议', options: { count: 20, offset: 0, site: null } }]);
});

test('Chrome is used only when BrowserOS is unavailable, reusing an open tab', async () => {
  let prepared;
  const chrome = {
    workspaceHome: async () => 'https://example.feishu.cn/drive/home/',
    prepareWorkspace: async (site) => { prepared = site; },
    search: async () => ({ total: 0, hasMore: false, items: [] }),
    disconnect: async () => {},
  };
  const { backend } = await searchKnowledgeBase('会议', {}, { available: async () => false, chrome: () => chrome });
  assert.equal(backend, 'chrome');
  assert.equal(prepared, 'https://example.feishu.cn/drive/home/');
});

test('a clear error is raised when neither backend has a Feishu session', async () => {
  process.env.FEISHU_GRAB_STATE = join(mkdtempSync(join(tmpdir(), 'feishu-grab-empty-')), 'state.json');
  const chrome = {
    workspaceHome: async () => { throw new Error('no tab'); },
    disconnect: async () => {},
  };
  await assert.rejects(
    searchKnowledgeBase('会议', {}, { available: async () => false, chrome: () => chrome }),
    /Open a Feishu tab in Chrome once, or start BrowserOS neo/,
  );
});
