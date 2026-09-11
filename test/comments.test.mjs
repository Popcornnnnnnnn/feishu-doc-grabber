import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyComments,
  collectCommentIds,
  commentStats,
  normalizeCommentThreads,
} from '../lib/comments.mjs';

test('comment IDs include current whole, anchored, and resolved API lists', () => {
  assert.deepEqual(collectCommentIds({
    wholeCommentIDs: ['whole-1'],
    partCommentIDs: ['part-1'],
    finishCommentIDs: ['resolved-1'],
  }), ['whole-1', 'part-1', 'resolved-1']);
});

test('comment IDs retain legacy relations and remove duplicates', () => {
  assert.deepEqual(collectCommentIds({
    commentRelations: { 'legacy-1': {}, 'shared-1': {} },
    wholeCommentIDs: ['shared-1', 'whole-1'],
  }), ['legacy-1', 'shared-1', 'whole-1']);
});

test('normalizes anchored, replied, resolved, and whole-document threads', () => {
  const idData = {
    wholeCommentIDs: ['whole-1'],
    partCommentIDs: ['part-1'],
    finishCommentIDs: ['resolved-1'],
    commentRelations: {
      'part-1': { relation: { first: { positionInfo: { blockID: 'block-a' } } } },
    },
  };
  const entry = (content, name = 'Reviewer') => ({ content, name, create_time: '2026-09-11 10:20:00' });
  const threads = normalizeCommentThreads(idData, { comments: {
    'whole-1': { is_whole: 1, comment_list: [entry('Whole note')] },
    'part-1': {
      quote: 'anchored text',
      comment_list: [entry('Root <script>'), entry('Reply\nline', 'Responder')],
    },
    'resolved-1': {
      position: JSON.stringify({ blockId: 'block-b' }),
      finish: 1,
      comment_list: [entry('Resolved note')],
    },
  }});

  const anchored = threads.find((thread) => thread.id === 'part-1');
  const resolved = threads.find((thread) => thread.id === 'resolved-1');
  assert.equal(anchored.blockId, 'block-a');
  assert.equal(anchored.entries[0].isReply, false);
  assert.equal(anchored.entries[1].isReply, true);
  assert.equal(anchored.entries[1].content, 'Reply line');
  assert.equal(resolved.resolved, true);
  assert.deepEqual(commentStats(threads), { threads: 3, anchored: 2, whole: 1, resolved: 1, replies: 1 });
});

test('renders anchored replies and resolved status while escaping comment HTML', () => {
  const body = applyComments('before anchored text⟦REF0⟧ after', [{
    quote: 'anchored text',
    resolved: true,
    entries: [
      { name: '<Reviewer>', time: '09-11 10:20', content: '<script>alert(1)</script>', isReply: false },
      { name: 'Responder', time: '09-11 10:21', content: 'reply', isReply: true },
    ],
  }]);
  assert.match(body, /<mark>anchored text<\/mark>/);
  assert.match(body, /data-comment-status="resolved"/);
  assert.match(body, /<br>↳ <b>Responder<\/b>/);
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(body, /<script>/);
});
