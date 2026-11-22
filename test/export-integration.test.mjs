import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { main } from '../grab.mjs';
import { savedLastReport } from '../lib/workspace-state.mjs';

test('isolated export traverses the asynchronous browser target and writes a complete report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-export-integration-'));
  const stateFile = join(dir, 'state.json');
  const previousState = process.env.FEISHU_GRAB_STATE;
  process.env.FEISHU_GRAB_STATE = stateFile;
  const originalFetch = globalThis.fetch;
  const originalConnect = puppeteer.connect;
  const originalExitCode = process.exitCode;
  let sessions = 0, disconnected = false;
  const data = {
    id: 'page', has_more: false, next_cursors: [], block_sequence: ['page', 'text'],
    block_map: {
      page: { id: 'page', data: { type: 'page', children: ['text'] } },
      text: { id: 'text', data: { type: 'text', parent_id: 'page', children: [],
        text: { initialAttributedTexts: { text: { 0: '完整导出 integration sentinel' } } } } },
    },
  };
  const html = `<title>Integration document</title><script>window.DATA = {clientVars: Object(${JSON.stringify({ data })})};</script>`;
  const target = {
    type: () => 'page',
    async createCDPSession() {
      sessions++;
      return { send: async () => ({ cookies: [] }), detach: async () => {} };
    },
  };
  puppeteer.connect = async () => ({ targets: () => [target], disconnect: () => { disconnected = true; } });
  globalThis.fetch = async (value) => {
    const url = new URL(value);
    if (url.hostname === '127.0.0.1' && url.pathname === '/json/version') return Response.json({ webSocketDebuggerUrl: 'ws://mock.invalid/' });
    if (url.hostname !== 'example.feishu.cn') throw new Error('Unexpected external request in integration test.');
    if (url.pathname === '/docx/Document') return new Response(html);
    if (url.pathname === '/space/api/comment/commentid/all') return Response.json({ code: 0, data: { wholeCommentIDs: [], partCommentIDs: [] } });
    throw new Error(`Unexpected test endpoint: ${url.pathname}`);
  };
  try {
    await main(['https://example.feishu.cn/docx/Document', '--browser', 'isolated', '--out', dir]);
    const report = JSON.parse(readFileSync(join(dir, 'export-report.json'), 'utf8'));
    assert.equal(report.documents[0].operationalStatus, 'success');
    assert.equal(report.documents[0].integrity.verdict, 'complete');
    assert.match(readFileSync(report.documents[0].output, 'utf8'), /完整导出 integration sentinel/);
    assert.equal(report.run.browser, 'isolated');
    assert.ok(sessions >= 2, 'Body and comments must both use the resolved browser target');
    assert.equal(disconnected, true);
    assert.ok(existsSync(join(dir, 'index.html')));
    const retryURLs = readFileSync(join(dir, 'retry-urls.txt'), 'utf8').split('\n').filter((line) => line.trim() && !line.startsWith('#'));
    assert.deepEqual(retryURLs, []);
    assert.equal(savedLastReport(stateFile), join(dir, 'export-report.json'));
  } finally {
    globalThis.fetch = originalFetch;
    puppeteer.connect = originalConnect;
    process.exitCode = originalExitCode;
    if (previousState === undefined) delete process.env.FEISHU_GRAB_STATE;
    else process.env.FEISHU_GRAB_STATE = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});
