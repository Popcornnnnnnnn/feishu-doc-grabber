import test from 'node:test';
import assert from 'node:assert/strict';
import { blockMapToMarkdown } from '../lib/ssr.mjs';

const text = (value, parent) => ({
  id: `text-${value}`,
  data: {
    type: 'text',
    parent_id: parent,
    children: [],
    text: { initialAttributedTexts: { text: { 0: value } } },
  },
});

test('native quote keeps its own text instead of only rendering children', () => {
  const blocks = {
    page: { id: 'page', data: { type: 'page', children: ['quote'] } },
    quote: {
      id: 'quote',
      data: { type: 'quote', parent_id: 'page', children: [], text: { initialAttributedTexts: { text: { 0: 'QUOTE-SENTINEL' } } } },
    },
  };
  assert.equal(blockMapToMarkdown(blocks, new Map())[0].md, '> QUOTE-SENTINEL');
});

test('native table follows row and column ids and preserves merged cells', () => {
  const a = text('A1', 'cell-a');
  const b = text('B1', 'cell-b');
  const c = text('MERGED-C2', 'cell-c');
  const blocks = {
    page: { id: 'page', data: { type: 'page', children: ['table'] } },
    table: {
      id: 'table',
      data: {
        type: 'table',
        parent_id: 'page',
        rows_id: ['r1', 'r2'],
        columns_id: ['c1', 'c2'],
        cell_set: {
          r1c1: { block_id: 'cell-a', merge_info: { row_span: 1, col_span: 1 } },
          r1c2: { block_id: 'cell-b', merge_info: { row_span: 1, col_span: 1 } },
          r2c1: { block_id: 'cell-c', merge_info: { row_span: 1, col_span: 2 } },
        },
      },
    },
    'cell-a': { id: 'cell-a', data: { type: 'table_cell', parent_id: 'table', children: [a.id] } },
    'cell-b': { id: 'cell-b', data: { type: 'table_cell', parent_id: 'table', children: [b.id] } },
    'cell-c': { id: 'cell-c', data: { type: 'table_cell', parent_id: 'table', children: [c.id] } },
    [a.id]: a,
    [b.id]: b,
    [c.id]: c,
  };
  const markdown = blockMapToMarkdown(blocks, new Map())[0].md;
  assert.match(markdown, /<td>A1<\/td>/);
  assert.match(markdown, /<td>B1<\/td>/);
  assert.match(markdown, /<td colspan="2">MERGED-C2<\/td>/);
});
