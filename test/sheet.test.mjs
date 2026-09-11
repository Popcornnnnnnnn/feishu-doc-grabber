import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCellBlock, decodeSheetClientVars, parseEmbeddedSheetRef, sheetToMarkdown } from '../lib/sheet.mjs';

const CELL_BLOCK = 'H4sIAAAAAAAAA62RwUrDQBCGZ3fTdFlSWFYPcQVZctBYWMhGoSGnpulWCwlIkr6Ad9/AR/DgI9ibHvoGnr0IXvUJpG+haBrtyZPf5ZuZf2AOw94IJeKZUO/yiTBOgYPvKW/oTq4uTByJFWI+tIxb0Y13xwLPp+Jovbx/v3tULw9qvbxR16o+t7bRuS0KPc2aTE9indjTXAxKW51ZbU2kZ8YI0e412bzQhYn1yWg0dL7OxwcUSVwZ2Z+l9aJMTdDL60UZBrgyAc6P0322x3BlxA4F/tGBfKIgAQnBIXM4hMAcjkKQroIQkoFkHHxo69jhWOH4FbFbhGALTJzfprcVuPBf9P+OqQDhUsIhao0iJFyKOURIUOpw8LtJZ/xt8mMSIbn53ScTFQDz2wEAAA==';
const BLOCK_META = 'H4sIAAAAAAAAA52Ry27DIBBF/2XWLABjjFlGbaUuKlWK1E1lWZTgBBWbCpw+YvHvlR9KmrSLqDvmDszccxlg1T4SikEOoI1zK+f164PpVQT5PEAw7zZa34GkAkFQ3daMN4P/WPcq9CAxGovbbgOSZAi0d6eG9m5qlCwheBkH329Azqe64IKRLC9pmXPBacFZVhMhBMaUE15TAQiiPRiQrMgRbA/2bT2VGSapQtD40O6dOvodbUW9M616MmG2zCi6ANipeDe/A9mHvZmUGxv6r6PcKBcNglZ9LtLomSz+T8FchUMyIVguRDnjtLY7n/lryQxM8U9ehlOVEgKSY940f/7Tf+Ig9DyOhfu6PPBFHlVK6RsvT3RmSgIAAA==';
const FORMULA_BLOCK = 'H4sIAAAAAAAAA6tWMlSyqlYqUbIy0lEqU7IyNKitBQAlc/I2FAAAAA==';
const CELL_BLOCK_ID = 'block_7684135929568627643_1888002616_28';
const FORMULA_BLOCK_ID = 'block_7684135929568627643_1138845889_28';

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
  assert.equal(decoded.cells.find((cell) => cell.address === 'D2').formulaId, 1);
  assert.equal(decoded.formulaExpressionsMissing, 1);
  assert.deepEqual(decoded.unknownCellTypes, []);
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
  assert.match(sheet.markdown, /<td data-formula-id="1" data-formula-expression="unavailable">10<\/td>/);
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
