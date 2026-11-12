import test from 'node:test';
import assert from 'node:assert/strict';
import { exportDocument, validateDocumentURL, safeName } from '../extension/exporter.mjs';
import { locateBoardBlock, stabilizeBoard } from '../extension/board-capture.mjs';
import { fixtureTransport, sourceURL, imageBytes, attachmentBytes } from '../tests/fixtures/extension-data.mjs';

test('extension export preserves paginated body, binary assets, anchored comments and replies', async () => {
  const result = await exportDocument({ url: sourceURL, transport: fixtureTransport() });
  const document = result.report.documents[0];
  assert.equal(document.integrity.verdict, 'complete');
  const markdown = new TextDecoder().decode(result.files[document.output]);
  for (const value of ['FIRST-PAGE-SENTINEL', 'LAST-PAGE-SENTINEL', 'COMMENT-SENTINEL', 'REPLY-SENTINEL', 'assets/image-1.png', 'attachments/1-']) assert.ok(markdown.includes(value), value);
  assert.ok(!markdown.includes('<script>not executable</script>'));
  assert.deepEqual(result.files['assets/image-1.png'], imageBytes);
  assert.deepEqual(Object.entries(result.files).find(([name]) => name.startsWith('attachments/'))[1], attachmentBytes);
  assert.ok(Object.keys(result.files).every((name) => !name.split('/').includes('..')));
  assert.equal(document.integrity.evidence.comments.replies, 1);
});

test('extension captures whiteboards when the transport can screenshot them', async () => {
  const transport = fixtureTransport({ scenario: 'whiteboard' });
  transport.capture = async ({ blockId }) => {
    assert.equal(blockId, 'board');
    return { bytes: imageBytes, route: 'debugger', width: 480, height: 320, sha256: 'fixture-digest' };
  };
  const result = await exportDocument({ url: sourceURL, transport });
  const document = result.report.documents[0];
  assert.equal(document.integrity.verdict, 'complete');
  assert.equal(document.integrity.checks.find((check) => check.name === 'whiteboards').status, 'pass');
  assert.deepEqual(document.integrity.evidence.boardCaptures,
    [{ blockId: 'board', route: 'debugger', width: 480, height: 320, sha256: 'fixture-digest' }]);
  const markdown = new TextDecoder().decode(result.files[document.output]);
  assert.ok(markdown.includes('assets/board-1.png'));
  assert.ok(!markdown.includes('ssrboard://'));
  assert.deepEqual(result.files['assets/board-1.png'], imageBytes);
});

test('injected board-capture functions are self-contained', async () => {
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
  globalThis.window = { scrollX: 0, scrollY: 0, innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1 };
  try {
    // chrome.scripting serializes only the function source into the page;
    // rebuild it in a scope without the module's helpers to match that.
    for (const injected of [locateBoardBlock, stabilizeBoard]) {
      const isolated = new Function(`return ${injected.toString()};`)();
      await assert.rejects(isolated('board', 0, 1), (error) => {
        assert.ok(!(error instanceof ReferenceError), 'injected function references module-scope helpers');
        assert.match(error.message, /board/);
        return true;
      });
    }
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});

test('exports Bitable wiki nodes as one CSV per data table', async () => {
  // The tenant reports numeric obj_type codes (8 = bitable), like production.
  const result = await exportDocument({ url: 'https://fixture.feishu.cn/wiki/BitableFixture?table=tblA&view=vewMain', transport: fixtureTransport({ scenario: 'bitable' }) });
  const document = result.report.documents[0];
  assert.equal(document.integrity.verdict, 'complete');
  assert.equal(document.integrity.route, 'bitable-csv');
  assert.equal(document.title, '任务管理');
  const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(result.files['tables/01-任务.csv']);
  assert.ok(csv.startsWith('\uFEFF任务描述,截止日期,负责人,数量,状态\r\n'), csv.slice(0, 80));
  assert.ok(csv.includes('写报告,2023-11-14 22:13,张三,42,已完成'));
  assert.ok(csv.includes('"带""引号"",和逗号",,,,\r\n'));
  assert.ok(Object.keys(result.files).includes('export-report.json'));
});

test('exports wiki-hosted docx documents via the numeric node type lookup', async () => {
  const result = await exportDocument({ url: 'https://fixture.feishu.cn/wiki/WikiDocFixture', transport: fixtureTransport() });
  const document = result.report.documents[0];
  assert.equal(document.integrity.verdict, 'complete');
  const markdown = new TextDecoder().decode(result.files[document.output]);
  assert.ok(markdown.includes('FIRST-PAGE-SENTINEL'));
});

for (const [scenario, verdict, checkName, checkStatus] of [
  ['unknown-pagination', 'degraded', 'pagination', 'warn'],
  ['pagination-failure', 'incomplete', 'pagination', 'fail'],
  ['media-failure', 'incomplete', 'images', 'fail'],
  ['comment-failure', 'degraded', 'comments', 'warn'],
  ['whiteboard', 'incomplete', 'whiteboards', 'fail'],
  ['missing-block', 'incomplete', 'block_structure', 'fail'],
]) {
  test(`extension truthfully reports ${scenario}`, async () => {
    const result = await exportDocument({ url: sourceURL, transport: fixtureTransport({ scenario }) });
    const { integrity } = result.report.documents[0];
    assert.equal(integrity.verdict, verdict);
    assert.equal(integrity.checks.find((check) => check.name === checkName).status, checkStatus);
  });
}

test('extension cancellation stops before downloading or producing an archive', async () => {
  const controller = new AbortController();
  const transport = fixtureTransport();
  const request = transport.request;
  transport.request = async (...args) => { controller.abort(); return request(...args); };
  transport.media = async () => { assert.fail('No resource request after cancellation'); };
  await assert.rejects(exportDocument({ url: sourceURL, transport, signal: controller.signal }), { name: 'AbortError' });
});

test('extension rejects unrelated, credential-bearing and lookalike URLs', () => {
  for (const url of ['https://feishu.cn.attacker.example/docx/abc', 'http://a.feishu.cn/docx/abc', 'https://user:secret@a.feishu.cn/docx/abc', 'https://a.feishu.cn/settings', 'javascript:alert(1)']) assert.throws(() => validateDocumentURL(url));
  assert.equal(validateDocumentURL('https://a.feishu.cn/wiki/abc?tracking=1#section').href, 'https://a.feishu.cn/wiki/abc');
  assert.equal(safeName('../CON.txt'), '_CON.txt');
});
