import test from 'node:test';
import assert from 'node:assert/strict';
import { blockMapToMarkdown, clientVarsDataToMarkdown } from '../lib/ssr.mjs';

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

test('file card view wrapper is recognized and renders its file child', () => {
  const blockMap = {
    page: { id: 'page', data: { type: 'page', children: ['view'] } },
    view: { id: 'view', data: { type: 'view', parent_id: 'page', view_type: 'Card', children: ['file'] } },
    file: {
      id: 'file',
      data: {
        type: 'file',
        parent_id: 'view',
        children: [],
        file: { token: 'fixture-token', name: 'fixture.txt', size: 21 },
      },
    },
  };
  const parsed = clientVarsDataToMarkdown({ block_map: blockMap, meta_map: {} });
  assert.match(parsed.markdown, /fixture\.txt/);
  assert.equal(parsed.stats.unknownBlocks, 0);
});

test('current todo and column block types render without unknown-block warnings', () => {
  const blockMap = {
    page: { id: 'page', data: { type: 'page', children: ['grid'] } },
    grid: { id: 'grid', data: { type: 'grid', parent_id: 'page', children: ['left', 'right'] } },
    left: { id: 'left', data: { type: 'grid_column', parent_id: 'grid', children: ['done'] } },
    right: { id: 'right', data: { type: 'grid_column', parent_id: 'grid', children: ['open'] } },
    done: {
      id: 'done',
      data: {
        type: 'todo', parent_id: 'left', children: [], done: true,
        text: { initialAttributedTexts: { text: { 0: 'LAYOUT-COL-A' } } },
      },
    },
    open: {
      id: 'open',
      data: {
        type: 'todo', parent_id: 'right', children: [], done: false,
        text: { initialAttributedTexts: { text: { 0: 'LAYOUT-COL-B' } } },
      },
    },
  };
  const parsed = clientVarsDataToMarkdown({ block_map: blockMap, meta_map: {} });
  assert.match(parsed.markdown, /- \[x\] LAYOUT-COL-A/);
  assert.match(parsed.markdown, /- \[ \] LAYOUT-COL-B/);
  assert.equal(parsed.stats.unknownBlocks, 0);
});

test('unparseable sheet SVG is explicitly routed to screenshot fallback', () => {
  const blockMap = {
    page: { id: 'page', data: { type: 'page', children: ['sheet'] } },
    sheet: {
      id: 'sheet',
      data: { type: 'sheet', parent_id: 'page', children: [], token: 'sheet-token' },
    },
  };
  const parsed = clientVarsDataToMarkdown(
    { block_map: blockMap, meta_map: {} },
    '<div id="ssr-sheet-svg"><svg><text>not a grid</text></svg></div>',
  );
  assert.match(parsed.markdown, /ssrsheet:\/\/sheet-token\/sheet/);
  assert.deepEqual(parsed.sheetFallbacks, [{ token: 'sheet-token', blockId: 'sheet' }]);
  assert.equal(parsed.stats.sheets, 1);
  assert.equal(parsed.stats.sheetTables, 0);
});

test('a partial sheet viewport is routed to screenshot fallback', () => {
  const blockMap = {
    page: { id: 'page', data: { type: 'page', children: ['sheet'] } },
    sheet: { id: 'sheet', data: { type: 'sheet', parent_id: 'page', token: 'sheet-token' } },
  };
  const horizontal = [0, 20, 40, 60]
    .map((y) => `<rect x="0" y="${y}" width="120" height="1"/>`).join('');
  const vertical = [0, 20, 70, 120]
    .map((x) => `<rect x="${x}" y="0" width="1" height="60"/>`).join('');
  const labels = [
    '<text x="30" y="10">G</text>', '<text x="80" y="10">H</text>',
    '<text x="5" y="30">3</text>', '<text x="30" y="30">partial</text>',
    '<text x="5" y="50">4</text>', '<text x="30" y="50">tail</text>',
  ].join('');
  const html = `<div id="ssr-sheet-svg"><svg>${horizontal}${vertical}${labels}</svg></div>`;
  const parsed = clientVarsDataToMarkdown({ block_map: blockMap, meta_map: {} }, html);
  assert.match(parsed.markdown, /ssrsheet:\/\/sheet-token\/sheet/);
  assert.deepEqual(parsed.sheetFallbacks, [{ token: 'sheet-token', blockId: 'sheet' }]);
  assert.equal(parsed.stats.sheetTables, 0);
});
