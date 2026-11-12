import assert from 'node:assert/strict';
import test from 'node:test';
import { renderResultPage, retryableDocuments } from '../lib/report.mjs';

const report = {
  generatedAt: '2026-09-11T08:00:00.000Z',
  documents: [
    {
      url: 'https://example.feishu.cn/wiki/Complete',
      output: '/tmp/Complete document.md',
      operationalStatus: 'success',
      integrity: { verdict: 'complete', checks: [] },
    },
    {
      url: 'https://example.feishu.cn/wiki/Incomplete',
      output: null,
      operationalStatus: 'failed',
      error: '<script>unsafe</script>',
      integrity: { verdict: 'incomplete', checks: [{ name: 'body', status: 'fail', detail: 'missing' }] },
    },
  ],
};

test('retry list contains every non-complete document', () => {
  assert.deepEqual(retryableDocuments(report).map((document) => document.url), [report.documents[1].url]);
});

test('result page summarizes output, links files, and escapes errors', () => {
  const html = renderResultPage(report);
  assert.match(html, /<b>1<\/b><span>Complete<\/span>/);
  assert.match(html, /Complete%20document\.md/);
  assert.match(html, /1 Document\(s\) Need a Retry/);
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>unsafe<\/script>/);
});
