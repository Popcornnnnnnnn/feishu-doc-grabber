import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  decodeCellBlock,
  decodeSheetClientVars,
  decodeSheetResourceMerges,
  parseEmbeddedSheetRef,
  sheetToMarkdown,
} from '../lib/sheet.mjs';

const CELL_BLOCK = 'H4sIAAAAAAAAA62RwUrDQBCGZ3fTdFlSWFYPcQVZctBYWMhGoSGnpulWCwlIkr6Ad9/AR/DgI9ibHvoGnr0IXvUJpG+haBrtyZPf5ZuZf2AOw94IJeKZUO/yiTBOgYPvKW/oTq4uTByJFWI+tIxb0Y13xwLPp+Jovbx/v3tULw9qvbxR16o+t7bRuS0KPc2aTE9indjTXAxKW51ZbU2kZ8YI0e412bzQhYn1yWg0dL7OxwcUSVwZ2Z+l9aJMTdDL60UZBrgyAc6P0322x3BlxA4F/tGBfKIgAQnBIXM4hMAcjkKQroIQkoFkHHxo69jhWOH4FbFbhGALTJzfprcVuPBf9P+OqQDhUsIhao0iJFyKOURIUOpw8LtJZ/xt8mMSIbn53ScTFQDz2wEAAA==';
const MERGED_CELL_BLOCK = 'H4sIAAAAAAAAA62RQUrDQBSG38yk6TikMIwuYgQZstBYGMhEoSGrpulUCwlIkl7AvTfwCC48gt3pwht4Ahd6AF1Lb6GkSWnBrT88vv+998NbPPZFKBEfhDo3b4RxChxcRzpDe3J7raNQvCDmQqtxC9rxYCzwfCpOV8un78dX+f4sV8t7eSerK2NqlZk8V9O0TtUkUrG5yMSgMOWlUUaHaqa1EG2uTue5ynWkzkejodWcj44p8nCpvf4sqRZFov1eVi2KwMel9nF2lhyxQ4ZLLfYp8J+NkEskxOCBf8IsDgEwi6MAPFtCAPHAYxxcaH1kcSxx9InYA0KwI0ysbdPbWdjwX+rTraf0z3pPgLAp4RC2RGvidU+pxcHdTDbEXRKHSDTVeBKC1/3vFyaXZPLfAQAA';
const BLOCK_META = 'H4sIAAAAAAAAA52Ry27DIBBF/2XWLABjjFlGbaUuKlWK1E1lWZTgBBWbCpw+YvHvlR9KmrSLqDvmDszccxlg1T4SikEOoI1zK+f164PpVQT5PEAw7zZa34GkAkFQ3daMN4P/WPcq9CAxGovbbgOSZAi0d6eG9m5qlCwheBkH329Azqe64IKRLC9pmXPBacFZVhMhBMaUE15TAQiiPRiQrMgRbA/2bT2VGSapQtD40O6dOvodbUW9M616MmG2zCi6ANipeDe/A9mHvZmUGxv6r6PcKBcNglZ9LtLomSz+T8FchUMyIVguRDnjtLY7n/lryQxM8U9ehlOVEgKSY940f/7Tf+Ig9DyOhfu6PPBFHlVK6RsvT3RmSgIAAA==';
const FORMULA_BLOCK = 'H4sIAAAAAAAAA6tWMlSyqlYqUbIy0lEqU7IyNKitBQAlc/I2FAAAAA==';
const CELL_BLOCK_ID = 'block_7684135929568627643_1888002616_28';
const FORMULA_BLOCK_ID = 'block_7684135929568627643_1138845889_28';

function varint(value) {
  let remaining = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function protobufField(number, value, wire = 2) {
  if (wire === 0) return Buffer.concat([varint(number << 3), varint(value)]);
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint((number << 3) | 2), varint(body.length), body]);
}

function mergedResourceFixture() {
  const range = Buffer.concat([
    protobufField(1, 9, 0),
    protobufField(2, 4, 0),
    protobufField(3, 11, 0),
    protobufField(4, 6, 0),
  ]);
  const merge = protobufField(2, range);
  const mutation = Buffer.concat([protobufField(1, 10, 0), protobufField(10, merge)]);
  const command = Buffer.concat([
    protobufField(1, 2, 0),
    protobufField(2, mutation),
    protobufField(3, 'BmP120'),
  ]);
  return gzipSync(protobufField(1, command)).toString('base64');
}

test('splits the embedded workbook token and sheet id used by doc blocks', () => {
  assert.deepEqual(parseEmbeddedSheetRef('Workbook123_BmP120'), { token: 'Workbook123', sheetId: 'BmP120' });
  assert.deepEqual(parseEmbeddedSheetRef('Workbook123:BmP120'), { token: 'Workbook123', sheetId: 'BmP120' });
  assert.deepEqual(parseEmbeddedSheetRef('Workbook123'), { token: 'Workbook123', sheetId: null });
});

test('decodes sparse Feishu sheet cells, Unicode, formula results, and offscreen tail', () => {
  const decoded = decodeCellBlock(CELL_BLOCK, { 1: { t: 2, v: 10 } });
  assert.deepEqual(decoded.range, { rowStart: 0, colStart: 0, rowCount: 12, colCount: 12 });
  assert.deepEqual(
    Object.fromEntries(decoded.cells.map((cell) => [cell.address, cell.value])),
    {
      A1: 'ID',
      B2: '表格 Ω 行 | SHEET-CELL-DATA-B2-8E4C',
      C2: 2,
      D2: 10,
      C3: 3,
      C4: 5,
      E10: 'MERGE-E10-F11',
      L12: 'SHEET-TAIL-L12-377',
    },
  );
  assert.deepEqual(
    decoded.cells.find((cell) => cell.address === 'D2'),
    { address: 'D2', row: 1, col: 3, type: 'formula', value: 10, formulaId: 1, formula: '=SUM(C2:C4)' },
  );
  assert.equal(decoded.formulaExpressionsMissing, 0);
  assert.deepEqual(decoded.unknownCellTypes, []);
});

test('treats explicit non-anchor cells in a merged range as structural blanks', () => {
  const decoded = decodeCellBlock(MERGED_CELL_BLOCK, { 1: { t: 2, v: 10 } });
  assert.deepEqual(decoded.unknownCellTypes, []);
  assert.deepEqual(
    decoded.cells.filter((cell) => ['F10', 'E11', 'F11'].includes(cell.address))
      .map((cell) => ({ address: cell.address, type: cell.type, value: cell.value })),
    [
      { address: 'F10', type: 'blank', value: null },
      { address: 'E11', type: 'blank', value: null },
      { address: 'F11', type: 'blank', value: null },
    ],
  );
});

test('requires every declared cell and formula block before structured sheet evidence is complete', () => {
  const payload = {
    data: {
      token: 'sheet-token', sheetId: 'BmP120', revision: 28,
      snapshot: { gzipBlockMeta: BLOCK_META, blocks: { [CELL_BLOCK_ID]: CELL_BLOCK } },
    },
  };
  const sheet = decodeSheetClientVars(payload, [{ data: { blocks: { [FORMULA_BLOCK_ID]: FORMULA_BLOCK } } }]);
  assert.equal(sheet.structuredComplete, true);
  assert.deepEqual(sheet.formulaBlocks, { expected: 1, received: 1 });
  assert.equal(sheet.missingFormulaValues, 0);
  assert.equal(sheet.formulaExpressionsMissing, 0);
  assert.match(sheet.markdown, /<td data-formula-id="1" data-formula-expression="=SUM\(C2:C4\)">10<\/td>/);
  assert.match(sheet.markdown, /SHEET-TAIL-L12-377/);

  const missingFormula = decodeSheetClientVars(payload);
  assert.equal(missingFormula.structuredComplete, false);
  assert.equal(missingFormula.missingFormulaValues, 1);
  assert.equal(missingFormula.cells.find((cell) => cell.address === 'D2').value, null);
});

test('sheet HTML labels rows and columns and escapes values', () => {
  const markdown = sheetToMarkdown({
    sheetId: 'sheet&1',
    range: { rowStart: 0, colStart: 0, rowCount: 1, colCount: 2 },
    cells: [{ address: 'A1', row: 0, col: 0, type: 'string', value: '<unsafe>' }],
  });
  assert.match(markdown, /data-feishu-sheet-id="sheet&amp;1"/);
  assert.match(markdown, /<th>A<\/th><th>B<\/th>/);
  assert.match(markdown, /<th>1<\/th><td>&lt;unsafe&gt;<\/td><td><\/td>/);
});

test('resource snapshots preserve merged Sheet ranges as rowspan and colspan', () => {
  const merges = decodeSheetResourceMerges(mergedResourceFixture(), 'BmP120');
  assert.deepEqual(merges, [{ startRow: 9, startCol: 4, endRow: 11, endCol: 6, rowSpan: 2, colSpan: 2 }]);
  const markdown = sheetToMarkdown({
    sheetId: 'BmP120',
    range: { rowStart: 9, colStart: 4, rowCount: 2, colCount: 2 },
    cells: [{ address: 'E10', row: 9, col: 4, type: 'string', value: 'MERGE-E10-F11' }],
    merges,
  });
  assert.match(markdown, /<td rowspan="2" colspan="2">MERGE-E10-F11<\/td>/);
  assert.doesNotMatch(markdown, /<td><\/td>/);
});
