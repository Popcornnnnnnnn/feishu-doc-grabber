import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCommentIds } from '../lib/comments.mjs';

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
