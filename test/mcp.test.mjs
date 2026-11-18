import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { TOOLS, handleMessage, main } from '../mcp/server.mjs';

const result = { total: 1, hasMore: false, items: [{ title: '会议纪要', url: 'https://example.feishu.cn/wiki/T', type: 22, space: '技术部', author: '示例成员', editedAt: null, preview: '讨论本周进度' }] };

function deps(overrides = {}) {
  return {
    search: async () => result,
    read: async () => '# 会议纪要\n\n正文内容',
    export: async () => ({ code: 0, output: 'exported 1 document', errors: '' }),
    ...overrides,
  };
}

test('initialize reports the server identity and tool capability', async () => {
  const response = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, deps());
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, 'feishu-grab');
  assert.equal(response.result.capabilities.tools.listChanged, false);
  assert.ok(response.result.protocolVersion);
});

test('tools/list exposes search and export with schemas', async () => {
  const response = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, deps());
  assert.deepEqual(response.result.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
  const search = response.result.tools.find((tool) => tool.name === 'feishu_search');
  assert.deepEqual(search.inputSchema.required, ['query']);
});

test('search returns formatted text and forwards its arguments', async () => {
  let received;
  const response = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'feishu_search', arguments: { query: '会议', limit: 1 } } }, deps({ search: async (args) => { received = args; return result; } }));
  assert.equal(received.query, '会议');
  assert.match(response.result.content[0].text, /会议纪要/);
  assert.match(response.result.content[0].text, /https:\/\/example\.feishu\.cn\/wiki\/T/);
  assert.match(response.result.content[0].text, /@示例成员/);
  assert.match(response.result.content[0].text, /讨论本周进度/);
});

test('read returns document content and validates url', async () => {
  let received;
  const response = await handleMessage({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'feishu_read', arguments: { url: 'https://example.feishu.cn/wiki/T', format: 'text' } } }, deps({ read: async (args) => { received = args; return '正文内容'; } }));
  assert.equal(received.url, 'https://example.feishu.cn/wiki/T');
  assert.equal(received.format, 'text');
  assert.equal(response.result.content[0].text, '正文内容');

  const missing = await handleMessage({ jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'feishu_read', arguments: {} } }, deps());
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /url is required/);
});

test('search can return the machine-readable result', async () => {
  const response = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'feishu_search', arguments: { query: '会议', json: true } } }, deps());
  assert.equal(JSON.parse(response.result.content[0].text).items[0].title, '会议纪要');
});

test('a missing query is reported as a tool error rather than a crash', async () => {
  const response = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'feishu_search', arguments: {} } }, deps());
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /query is required/);
});

test('export reports the child process result', async () => {
  const response = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'feishu_export', arguments: { urls: ['https://example.feishu.cn/docx/T'] } } }, deps());
  assert.match(response.result.content[0].text, /exported 1 document/);
  assert.match(response.result.content[0].text, /exit 0/);
});

test('unknown methods and notifications are handled without breaking the stream', async () => {
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, deps())).error.code, -32601);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps()), null);
});

test('main reads newline-delimited JSON and answers in order', async () => {
  const messages = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ].join('\n') + '\n';
  let captured = '';
  const output = new Writable({ write(chunk, _encoding, callback) { captured += chunk; callback(); } });
  await main({ input: Readable.from([messages]), output });
  const replies = captured.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(replies.length, 2);
  assert.deepEqual(replies.map((reply) => reply.id), [1, 2]);
});
