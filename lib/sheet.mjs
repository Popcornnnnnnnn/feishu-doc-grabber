import { gunzipSync } from 'fflate';

const utf8 = new TextDecoder();
const fromBase64 = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const decodeGzipJson = (value) => JSON.parse(utf8.decode(gunzipSync(fromBase64(value))));

function readVarint(buffer, start) {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < buffer.length) {
    const byte = BigInt(buffer[offset++]);
    value |= (byte & 0x7fn) << shift;
    if (!(byte & 0x80n)) return { value, offset };
    shift += 7n;
    if (shift > 70n) throw new Error('Invalid protobuf varint');
  }
  throw new Error('Truncated protobuf varint');
}

function fields(buffer) {
  const result = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const number = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (!number || ![0, 1, 2, 5].includes(wire)) throw new Error(`Unsupported protobuf wire type ${wire}`);
    if (wire === 0) {
      const item = readVarint(buffer, offset);
      offset = item.offset;
      result.push({ number, wire, value: item.value });
      continue;
    }
    let size;
    if (wire === 1) size = 8;
    else if (wire === 5) size = 4;
    else {
      const length = readVarint(buffer, offset);
      size = Number(length.value);
      offset = length.offset;
    }
    if (offset + size > buffer.length) throw new Error('Truncated protobuf field');
    result.push({ number, wire, bytes: buffer.subarray(offset, offset + size) });
    offset += size;
  }
  return result;
}

function decodePackedVarints(buffer) {
  const values = [];
  let offset = 0;
  while (offset < buffer.length) {
    const item = readVarint(buffer, offset);
    values.push(Number(item.value));
    offset = item.offset;
  }
  return values;
}

function one(list, number, wire) {
  return list.find((item) => item.number === number && (wire === undefined || item.wire === wire));
}

function all(list, number, wire) {
  return list.filter((item) => item.number === number && (wire === undefined || item.wire === wire));
}

function integer(list, number, fallback = 0) {
  const item = one(list, number, 0);
  return item ? Number(item.value) : fallback;
}

function signedInteger(list, number, fallback = 0) {
  const item = one(list, number, 0);
  return item ? Number(BigInt.asIntN(32, item.value)) : fallback;
}

function message(list, number) {
  const item = one(list, number, 2);
  if (!item) throw new Error(`Missing protobuf message field ${number}`);
  return fields(item.bytes);
}

function text(item) {
  return utf8.decode(item.bytes);
}

function decodeNumbers(item) {
  if (item.bytes.length % 8) throw new Error('Invalid packed double dictionary');
  const values = [];
  const view = new DataView(item.bytes.buffer, item.bytes.byteOffset, item.bytes.byteLength);
  for (let offset = 0; offset < item.bytes.length; offset += 8) values.push(view.getFloat64(offset, true));
  return values;
}

function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const digit = (value - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function decodeFormulaData(item) {
  const list = fields(item.bytes);
  return {
    version: integer(list, 1),
    tree: all(list, 3, 2).map(text),
    tokens: all(list, 4, 2).map(text),
    params: all(list, 7, 2).map(text),
  };
}

function decodeGridRange(item) {
  const list = fields(item.bytes);
  return {
    startRow: signedInteger(list, 1),
    startCol: signedInteger(list, 2),
    endRow: signedInteger(list, 3),
    endCol: signedInteger(list, 4),
    sheetId: one(list, 5, 2) ? text(one(list, 5, 2)) : null,
    sheetName: one(list, 6, 2) ? text(one(list, 6, 2)) : null,
    status: integer(list, 7),
  };
}

function decodeFormulaRefMap(item) {
  const list = fields(item.bytes);
  return Object.fromEntries(all(list, 1, 2).map((entryItem) => {
    const entry = fields(entryItem.bytes);
    const key = one(entry, 1, 2);
    const value = one(entry, 2, 2);
    if (!key || !value) throw new Error('Invalid formula reference map entry');
    return [text(key), decodeGridRange(value)];
  }));
}

function sheetNamePrefix(range, sheetId) {
  if (!range.sheetId || range.sheetId === sheetId) return '';
  if (!range.sheetName) return null;
  const name = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(range.sheetName)
    ? range.sheetName
    : `'${range.sheetName.replaceAll("'", "''")}'`;
  return `${name}!`;
}

function rangeToA1(range, originRow, originCol, sheetId) {
  const status = range.status ?? 0;
  const rangeType = status >> 4;
  if (![0, 3, 12].includes(rangeType)) return null;
  const prefix = sheetNamePrefix(range, sheetId);
  if (prefix === null) return null;

  const startRow = status & 4 ? range.startRow : originRow + range.startRow;
  const endRow = status & 8 ? range.endRow : originRow + range.endRow;
  const startCol = status & 1 ? range.startCol : originCol + range.startCol;
  const endCol = status & 2 ? range.endCol : originCol + range.endCol;
  const rowRef = (index, absolute) => `${absolute ? '$' : ''}${index + 1}`;
  const colRef = (index, absolute) => `${absolute ? '$' : ''}${columnName(index)}`;

  if (rangeType === 3) {
    if (startRow < 0 || endRow <= startRow) return null;
    return `${prefix}${rowRef(startRow, status & 4)}:${rowRef(endRow - 1, status & 8)}`;
  }
  if (rangeType === 12) {
    if (startCol < 0 || endCol <= startCol) return null;
    return `${prefix}${colRef(startCol, status & 1)}:${colRef(endCol - 1, status & 2)}`;
  }
  if (startRow < 0 || startCol < 0 || endRow <= startRow || endCol <= startCol) return null;

  const first = `${colRef(startCol, status & 1)}${rowRef(startRow, status & 4)}`;
  const last = `${colRef(endCol - 1, status & 2)}${rowRef(endRow - 1, status & 8)}`;
  return `${prefix}${first === last ? first : `${first}:${last}`}`;
}

function decodeFormulaExpression(formula, formulaDatas, formulaRefMaps, row, col, sheetId) {
  const data = formulaDatas[formula.formulaDataId];
  if (!data?.tokens?.length || data.version !== 1) return null;
  const refs = formulaRefMaps[formula.formulaRefMapId] ?? {};
  let expression = '';
  for (const token of data.tokens) {
    if (token.startsWith('C')) expression += token.slice(1);
    else if (token.startsWith('R')) {
      const reference = refs[token] && rangeToA1(refs[token], row, col, sheetId);
      if (!reference) return null;
      expression += reference;
    } else if (token.startsWith('P')) {
      const parameter = data.params[Number(token.slice(1))];
      if (parameter === undefined) return null;
      expression += parameter;
    } else return null;
  }
  return expression.startsWith('=') ? expression : `=${expression}`;
}

export function decodeSheetResourceMerges(encoded, sheetId) {
  const commands = fields(gunzipSync(fromBase64(encoded)));
  const merges = [];
  for (const commandItem of all(commands, 1, 2)) {
    const command = fields(commandItem.bytes);
    const commandSheet = one(command, 3, 2);
    if (commandSheet && text(commandSheet) !== sheetId) continue;
    for (const mutationItem of all(command, 2, 2)) {
      const mutation = fields(mutationItem.bytes);
      if (integer(mutation, 1) !== 10) continue;
      const mergeMutation = one(mutation, 10, 2);
      if (!mergeMutation) continue;
      for (const rangeItem of all(fields(mergeMutation.bytes), 2, 2)) {
        const range = decodeGridRange(rangeItem);
        if (range.endRow <= range.startRow || range.endCol <= range.startCol) continue;
        merges.push({
          startRow: range.startRow,
          startCol: range.startCol,
          endRow: range.endRow,
          endCol: range.endCol,
          rowSpan: range.endRow - range.startRow,
          colSpan: range.endCol - range.startCol,
        });
      }
    }
  }
  return merges;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function parseEmbeddedSheetRef(value) {
  const match = /^([A-Za-z0-9]+)[:_]([A-Za-z0-9]+)$/.exec(value);
  return match ? { token: match[1], sheetId: match[2] } : { token: value, sheetId: null };
}

function parseCellBlockBuffer(buffer, formulaValues = {}) {
  const envelope = message(fields(buffer), 1);
  const payload = message(message(envelope, 2), 12);
  const rangeFields = message(payload, 1);
  const dictionary = message(payload, 2);
  const cellTable = message(payload, 6);
  const rowStart = integer(rangeFields, 1);
  const colStart = integer(rangeFields, 2);
  const rowCount = integer(rangeFields, 3);
  const colCount = integer(rangeFields, 4);
  const sheetId = text(one(rangeFields, 5, 2));
  const occupancyBytes = one(cellTable, 1, 2)?.bytes ?? new Uint8Array(0);
  const occupancy = decodePackedVarints(occupancyBytes);
  if (occupancy.length !== rowCount * colCount) {
    throw new Error(`Sheet occupancy has ${occupancy.length} entries, expected ${rowCount * colCount}`);
  }

  const numberItem = one(dictionary, 1, 2);
  const numbers = numberItem ? decodeNumbers(numberItem) : [];
  const strings = all(dictionary, 2, 2).map(text);
  const richTexts = all(dictionary, 3, 2).map((item) => fields(item.bytes));
  const formulaStrings = all(dictionary, 4, 2).map(text);
  const formulas = all(dictionary, 5, 2).map((item) => {
    const list = fields(item.bytes);
    return { formulaDataId: integer(list, 1), formulaRefMapId: integer(list, 2) };
  });
  const formulaDatas = all(dictionary, 6, 2).map(decodeFormulaData);
  const formulaRefMaps = all(dictionary, 7, 2).map(decodeFormulaRefMap);
  const descriptors = all(cellTable, 2, 2).map((item) => fields(item.bytes));
  const cells = [];
  const unknownCellTypes = [];
  let formulaExpressionsMissing = 0;

  for (let offset = 0; offset < occupancy.length; offset++) {
    const descriptorIndex = occupancy[offset];
    if (!descriptorIndex) continue;
    const descriptor = descriptors[descriptorIndex];
    if (!descriptor) throw new Error(`Missing cell descriptor ${descriptorIndex}`);
    const typeCode = integer(descriptor, 1);
    const valueIndex = integer(descriptor, 2);
    const row = rowStart + Math.floor(offset / colCount);
    const col = colStart + (offset % colCount);
    let value;
    let type;
    let formulaId = null;
    let formula = null;
    if (typeCode === 0) {
      // Feishu materializes the non-anchor cells of a merged range as explicit
      // blank descriptors. They are valid structural cells, not unknown data.
      type = 'blank';
      value = null;
    } else if (typeCode === 2) {
      type = 'number';
      value = numbers[valueIndex];
    } else if (typeCode === 3) {
      type = 'string';
      value = strings[valueIndex];
    } else if (typeCode === 4) {
      type = 'formula';
      formulaId = integer(descriptor, 3, valueIndex);
      value = formulaValues[String(formulaId)]?.v;
      formula = formulas[valueIndex]
        ? decodeFormulaExpression(formulas[valueIndex], formulaDatas, formulaRefMaps, row, col, sheetId)
        : null;
      if (formula === null) formulaExpressionsMissing += 1;
    } else if (typeCode === 5) {
      type = 'formula-string';
      formula = formulaStrings[valueIndex] ?? null;
      if (formula !== null && !formula.startsWith('=')) formula = `=${formula}`;
      value = formula;
      if (formula === null) formulaExpressionsMissing += 1;
    } else if (typeCode === 6) {
      const rich = richTexts[valueIndex];
      const stringIndex = rich ? integer(rich, 1, -1) : -1;
      if (stringIndex >= 0 && strings[stringIndex] !== undefined) {
        type = 'rich-text';
        value = strings[stringIndex];
      } else {
        type = 'unknown';
        unknownCellTypes.push({ row, col, typeCode });
      }
    } else {
      type = 'unknown';
      unknownCellTypes.push({ row, col, typeCode });
    }
    cells.push({
      address: `${columnName(col)}${row + 1}`,
      row,
      col,
      type,
      value: value ?? null,
      ...(formulaId === null && formula === null ? {} : { ...(formulaId === null ? {} : { formulaId }), formula }),
    });
  }

  return {
    sheetId,
    range: { rowStart, colStart, rowCount, colCount },
    cells,
    unknownCellTypes,
    formulaExpressionsMissing,
  };
}

export function decodeCellBlock(encoded, formulaValues = {}) {
  return parseCellBlockBuffer(gunzipSync(fromBase64(encoded)), formulaValues);
}

export function decodeFormulaValues(payloads) {
  const values = {};
  for (const payload of payloads) {
    for (const encoded of Object.values(payload?.data?.blocks ?? {})) {
      const decoded = decodeGzipJson(encoded);
      Object.assign(values, decoded);
    }
  }
  return values;
}

export function sheetBlockRequirements(payload) {
  const data = payload?.data ?? payload;
  const snapshot = data?.snapshot;
  if (!snapshot?.gzipBlockMeta) throw new Error('Sheet client_vars is missing gzipBlockMeta');
  const blockMeta = decodeGzipJson(snapshot.gzipBlockMeta);
  const meta = blockMeta[data.sheetId];
  if (!meta) throw new Error(`Sheet metadata is missing ${data.sheetId}`);
  return {
    cellBlockIds: (meta.cellBlockMetas ?? []).map((item) => item.blockId),
    formulaBlockIds: (meta.formulaBlockMeta?.blockMetas ?? []).map((item) => item.blockId),
  };
}

export function sheetToMarkdown(sheet) {
  const { rowStart, colStart, rowCount, colCount } = sheet.range;
  const byPosition = new Map(sheet.cells.map((cell) => [`${cell.row}:${cell.col}`, cell]));
  const mergeAnchors = new Map();
  const coveredByMerge = new Set();
  for (const merge of sheet.merges ?? []) {
    if (merge.startRow < rowStart || merge.startCol < colStart
      || merge.endRow > rowStart + rowCount || merge.endCol > colStart + colCount) continue;
    mergeAnchors.set(`${merge.startRow}:${merge.startCol}`, merge);
    for (let row = merge.startRow; row < merge.endRow; row++) {
      for (let col = merge.startCol; col < merge.endCol; col++) {
        if (row !== merge.startRow || col !== merge.startCol) coveredByMerge.add(`${row}:${col}`);
      }
    }
  }
  const header = [''].concat(Array.from({ length: colCount }, (_, index) => columnName(colStart + index)));
  const rows = [
    `<table data-feishu-sheet-id="${escapeHtml(sheet.sheetId)}">`,
    `<thead><tr>${header.map((value) => `<th>${escapeHtml(value)}</th>`).join('')}</tr></thead>`,
    '<tbody>',
  ];
  for (let row = rowStart; row < rowStart + rowCount; row++) {
    const columns = [`<th>${row + 1}</th>`];
    for (let col = colStart; col < colStart + colCount; col++) {
      if (coveredByMerge.has(`${row}:${col}`)) continue;
      const cell = byPosition.get(`${row}:${col}`);
      const attrs = [];
      const merge = mergeAnchors.get(`${row}:${col}`);
      if (merge?.rowSpan > 1) attrs.push(`rowspan="${merge.rowSpan}"`);
      if (merge?.colSpan > 1) attrs.push(`colspan="${merge.colSpan}"`);
      if (cell?.type === 'formula' || cell?.type === 'formula-string') {
        if (cell.formulaId !== undefined) attrs.push(`data-formula-id="${cell.formulaId}"`);
        attrs.push(`data-formula-expression="${escapeHtml(cell.formula ?? 'unavailable')}"`);
      }
      columns.push(`<td${attrs.length ? ` ${attrs.join(' ')}` : ''}>${escapeHtml(cell?.value ?? '')}</td>`);
    }
    rows.push(`<tr>${columns.join('')}</tr>`);
  }
  rows.push('</tbody>', '</table>');
  return rows.join('\n');
}

export function decodeSheetClientVars(payload, formulaPayloads = []) {
  const data = payload?.data ?? payload;
  const snapshot = data?.snapshot;
  if (!snapshot?.gzipBlockMeta) throw new Error('Sheet client_vars is missing gzipBlockMeta');
  const blockMeta = decodeGzipJson(snapshot.gzipBlockMeta);
  const sheetId = data.sheetId;
  const meta = blockMeta[sheetId];
  if (!meta) throw new Error(`Sheet metadata is missing ${sheetId}`);
  const formulaValues = decodeFormulaValues(formulaPayloads);
  const merges = snapshot.gzipResource ? decodeSheetResourceMerges(snapshot.gzipResource, sheetId) : [];
  const expectedBlocks = (meta.cellBlockMetas ?? []).map((item) => item.blockId);
  const missingBlocks = expectedBlocks.filter((blockId) => !snapshot.blocks?.[blockId]);
  const decodedBlocks = expectedBlocks
    .filter((blockId) => snapshot.blocks?.[blockId])
    .map((blockId) => decodeCellBlock(snapshot.blocks[blockId], formulaValues));
  const cells = decodedBlocks.flatMap((block) => block.cells);
  const unknownCellTypes = decodedBlocks.flatMap((block) => block.unknownCellTypes);
  const formulaExpressionsMissing = decodedBlocks.reduce((sum, block) => sum + block.formulaExpressionsMissing, 0);
  const missingFormulaValues = cells.filter((cell) => cell.type === 'formula' && cell.value === null).length;
  const ranges = decodedBlocks.map((block) => block.range);
  const rowStart = ranges.length ? Math.min(...ranges.map((range) => range.rowStart)) : 0;
  const colStart = ranges.length ? Math.min(...ranges.map((range) => range.colStart)) : 0;
  const rowEnd = ranges.length ? Math.max(...ranges.map((range) => range.rowStart + range.rowCount)) : 0;
  const colEnd = ranges.length ? Math.max(...ranges.map((range) => range.colStart + range.colCount)) : 0;
  const expectedFormulaBlocks = meta.formulaBlockMeta?.blockMetas?.length ?? 0;
  const receivedFormulaBlocks = formulaPayloads.reduce((sum, item) => sum + Object.keys(item?.data?.blocks ?? {}).length, 0);
  const sheet = {
    token: data.token,
    sheetId,
    revision: data.revision,
    range: { rowStart, colStart, rowCount: rowEnd - rowStart, colCount: colEnd - colStart },
    cells,
    merges,
    missingBlocks,
    unknownCellTypes,
    formulaExpressionsMissing,
    missingFormulaValues,
    formulaBlocks: { expected: expectedFormulaBlocks, received: receivedFormulaBlocks },
  };
  sheet.structuredComplete = missingBlocks.length === 0
    && unknownCellTypes.length === 0
    && missingFormulaValues === 0
    && receivedFormulaBlocks >= expectedFormulaBlocks;
  sheet.markdown = sheetToMarkdown(sheet);
  return sheet;
}
