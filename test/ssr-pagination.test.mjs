import test from 'node:test';
import assert from 'node:assert/strict';
import { clientVarsDataToMarkdown, mergeClientVarsPages } from '../lib/ssr.mjs';

const block = (id, type, parentId, value = '') => ({
  id,
  data: {
    type,
    parent_id: parentId,
    children: [],
    text: value ? { initialAttributedTexts: { text: { 0: value } } } : undefined,
  },
});

test('SSR pages merge in cursor order and extend the page children list', () => {
  const initial = {
    id: 'page',
    has_more: true,
    next_cursors: ['cursor-2', 'cursor-3'],
    block_sequence: ['page', 'h1'],
    block_map: {
      page: { id: 'page', data: { type: 'page', children: ['h1'] } },
      h1: block('h1', 'heading2', 'page', 'Section 1'),
    },
  };
  const second = {
    id: 'page', has_more: true, next_cursors: [], block_sequence: ['h2'],
    block_map: { h2: block('h2', 'heading2', 'page', 'Section 2') },
  };
  const third = {
    id: 'page', has_more: false, next_cursors: [], block_sequence: ['h3'],
    block_map: { h3: block('h3', 'heading2', 'page', 'Section 3') },
  };

  const merged = mergeClientVarsPages(initial, [second, third]);
  assert.equal(merged.has_more, false);
  assert.deepEqual(merged.block_map.page.data.children, ['h1', 'h2', 'h3']);
  assert.match(clientVarsDataToMarkdown(merged).markdown, /Section 1[\s\S]*Section 2[\s\S]*Section 3/);
});
