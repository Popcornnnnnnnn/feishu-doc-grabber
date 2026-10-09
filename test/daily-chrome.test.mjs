import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { DailyChrome, allowedRequest, appleString } from '../lib/daily-chrome.mjs';

const source = 'https://example.feishu.cn/docx/Document';
const api = 'https://example.feishu.cn/space/api/comment/batch';

function pageBrowser({ fetch, url = source } = {}) {
  const scripts = [];
  const context = vm.createContext({
    location: { href: url }, document: { readyState: 'complete' },
    fetch, AbortController, Uint8Array, setTimeout, clearTimeout,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  });
  for (const name of ['cookie', 'localStorage', 'sessionStorage']) {
    Object.defineProperty(name === 'cookie' ? context.document : context, name, {
      get() { throw new Error(`Authentication data must not be read: ${name}`); },
    });
  }
  const run = async (script) => {
    scripts.push(script);
    if (script.includes('set rows to')) return `1\t42\t${context.location.href}`;
    const match = /execute t javascript ("(?:\\.|[^"\\])*")/.exec(script);
    assert.ok(match, 'Only documented Chrome JavaScript calls should reach the fake page');
    return String(vm.runInContext(JSON.parse(match[1]), context));
  };
  return { browser: new DailyChrome({ run, timeoutMs: 2000 }), context, scripts };
}

test('daily transport permits only Feishu document reads and approved media', () => {
  assert.equal(allowedRequest(source, source), true);
  assert.equal(allowedRequest(source, api, 'POST'), true);
  assert.equal(allowedRequest(source, 'https://example.feishu.cn/space/api/docx/delete', 'POST'), false);
  assert.equal(allowedRequest(source, 'https://other.feishu.cn/docx/Other'), false);
  assert.equal(allowedRequest(source, 'https://example.feishu.cn/perf/private'), false);
  assert.equal(allowedRequest(source, source, 'DELETE'), false);
  assert.equal(allowedRequest(source, 'http://example.feishu.cn/docx/Document'), false);
  assert.equal(allowedRequest(source, 'https://user:password@example.feishu.cn/docx/Document'), false);
  assert.equal(allowedRequest(source, 'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/Image/?preview_type=16'), true);
  assert.equal(allowedRequest(source, 'https://internal-api-drive-stream.feishu.cn.evil.test/space/api/box/stream/download/preview/Image/'), false);
});

test('AppleScript strings cannot inject extra AppleScript or shell commands', () => {
  const value = '"\nend tell\n$() `test` \\ 汉字';
  assert.equal(JSON.parse(appleString(value)), value);
  assert.equal(appleString(value).includes('\n'), false);
});

test('daily transport reads Unicode and multi-chunk binary responses without exporting credentials', async () => {
  const bytes = Buffer.from('正文 🧪\n'.repeat(40000));
  let request;
  const { browser, context, scripts } = pageBrowser({ fetch: async (url, options) => {
    request = { url, options };
    const response = new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  } });
  await browser.prepare(source);
  const response = await browser.request(api, { method: 'POST', headers: {
    cookie: 'must-never-leave-node', 'x-csrftoken': 'must-never-leave-node',
    'user-agent': 'discarded', referer: source, 'content-type': 'application/json',
  }, body: '{}' });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.url, api);
  assert.equal(request.options.credentials, 'include');
  assert.equal(request.options.body, '{}');
  assert.deepEqual({ ...request.options.headers }, { 'content-type': 'application/json' });
  assert.equal(Object.keys(context).some((key) => key.startsWith('__feishuCLI_')), false);
  assert.equal(scripts.some((script) => script.includes('must-never-leave-node')), false);
  assert.equal(scripts.some((script) => script.includes('make new tab')), false);
});

test('daily transport refuses a login redirect and cleans its page job', async () => {
  const { browser, context } = pageBrowser({ fetch: async () => {
    const response = new Response('login');
    Object.defineProperty(response, 'url', { value: 'https://accounts.feishu.cn/login' });
    return response;
  } });
  await browser.prepare(source);
  await assert.rejects(browser.request(source), /redirected away/);
  assert.equal(Object.keys(context).some((key) => key.startsWith('__feishuCLI_')), false);
});

test('daily transport maps the legacy all resource route to original-file preview', async () => {
  let requested;
  const { browser } = pageBrowser({ fetch: async (url) => {
    requested = new URL(url);
    const response = new Response('asset');
    Object.defineProperty(response, 'url', { value: url });
    return response;
  } });
  await browser.prepare(source);
  await browser.request('https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/all/Image/?mount_node_token=Block');
  assert.equal(requested.pathname, '/space/api/box/stream/download/preview/Image/');
  assert.equal(requested.searchParams.get('preview_type'), '16');
  assert.equal(requested.searchParams.get('mount_node_token'), 'Block');
});

test('daily transport stops when the user navigates an existing tab', async () => {
  let requests = 0;
  const { browser, context } = pageBrowser({ fetch: () => { requests++; } });
  await browser.prepare(source);
  context.location.href = 'https://example.com/';
  await assert.rejects(browser.request(source), /source tab changed/);
  assert.equal(requests, 0);
  await browser.disconnect();
});

test('daily transport enforces its resource limit before reading an oversized body', async () => {
  const { browser } = pageBrowser({ fetch: async (url) => {
    const response = new Response('oversized', { headers: { 'content-length': String(101 * 1024 * 1024) } });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  } });
  await browser.prepare(source);
  await assert.rejects(browser.request(source), /100 MB export limit/);
});

test('daily transport reports server denial instead of exporting an error page', async () => {
  const { browser } = pageBrowser({ fetch: async (url) => {
    const response = new Response('denied', { status: 403 });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  } });
  await browser.prepare(source);
  await assert.rejects(browser.request(source), /HTTP 403/);
});

test('daily transport does not close a temporary tab navigated by the user', async () => {
  const calls = [];
  const browser = new DailyChrome({ run: async (script) => {
    calls.push(script);
    return '1\t42\thttps://example.feishu.cn/docx/Other';
  } });
  browser.created.set(42, source);
  await browser.disconnect();
  assert.equal(calls.length, 1);
});

test('CLI uses daily Chrome and rejects unsupported rendering before browser operations', () => {
  const cli = spawnSync(process.execPath, ['cli.mjs', source, '--format', 'pdf'], { encoding: 'utf8' });
  assert.equal(cli.status, 64);
  assert.match(cli.stderr, /use --browser isolated/);
  const help = spawnSync(process.execPath, ['cli.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /daily Chrome/);
  assert.match(help.stdout, /--current/);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(manifest.bin['feishu-grab'], './cli.mjs');
  assert.ok(manifest.files.includes('cli.mjs'));
});
