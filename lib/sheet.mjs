import { gunzipSync } from 'node:zlib';

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

function message(list, number) {
  const item = one(list, number, 2);
  if (!item) throw new Error(`Missing protobuf message field ${number}`);
  return fields(item.bytes);
}

function text(item) {
  return item.bytes.toString('utf8');
}

function decodeNumbers(item) {
  if (item.bytes.length % 8) throw new Error('Invalid packed double dictionary');
  const values = [];
  for (let offset = 0; offset < item.bytes.length; offset += 8) values.push(item.bytes.readDoubleLE(offset));
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
  const occupancy = one(cellTable, 1, 2)?.bytes ?? Buffer.alloc(0);
  if (occupancy.length !== rowCount * colCount) {
    throw new Error(`Sheet occupancy is ${occupancy.length} bytes, expected ${rowCount * colCount}`);
  }

  const numberItem = one(dictionary, 1, 2);
  const numbers = numberItem ? decodeNumbers(numberItem) : [];
  const strings = all(dictionary, 2, 2).map(text);
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
    if (typeCode === 2) {
      type = 'number';
      value = numbers[valueIndex];
    } else if (typeCode === 3) {
      type = 'string';
      value = strings[valueIndex];
    } else if (typeCode === 4) {
      type = 'formula';
      formulaId = integer(descriptor, 3, valueIndex);
      value = formulaValues[String(formulaId)]?.v;
      formulaExpressionsMissing += 1;
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
      ...(formulaId === null ? {} : { formulaId, formula: null }),
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
  return parseCellBlockBuffer(gunzipSync(Buffer.from(encoded, 'base64')), formulaValues);
}

export function decodeFormulaValues(payloads) {
  const values = {};
  for (const payload of payloads) {
    for (const encoded of Object.values(payload?.data?.blocks ?? {})) {
      const decoded = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'));
      Object.assign(values, decoded);
    }
  }
  return values;
}

export function sheetBlockRequirements(payload) {
  const data = payload?.data ?? payload;
  const snapshot = data?.snapshot;
  if (!snapshot?.gzipBlockMeta) throw new Error('Sheet client_vars is missing gzipBlockMeta');
  const blockMeta = JSON.parse(gunzipSync(Buffer.from(snapshot.gzipBlockMeta, 'base64')).toString('utf8'));
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
  const header = [''].concat(Array.from({ length: colCount }, (_, index) => columnName(colStart + index)));
  const rows = [
    `<table data-feishu-sheet-id="${escapeHtml(sheet.sheetId)}">`,
    `<thead><tr>${header.map((value) => `<th>${escapeHtml(value)}</th>`).join('')}</tr></thead>`,
    '<tbody>',
  ];
  for (let row = rowStart; row < rowStart + rowCount; row++) {
    const columns = [`<th>${row + 1}</th>`];
    for (let col = colStart; col < colStart + colCount; col++) {
      const cell = byPosition.get(`${row}:${col}`);
      const attrs = cell?.type === 'formula'
        ? ` data-formula-id="${cell.formulaId}" data-formula-expression="unavailable"`
        : '';
      columns.push(`<td${attrs}>${escapeHtml(cell?.value ?? '')}</td>`);
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
  const blockMeta = JSON.parse(gunzipSync(Buffer.from(snapshot.gzipBlockMeta, 'base64')).toString('utf8'));
  const sheetId = data.sheetId;
  const meta = blockMeta[sheetId];
  if (!meta) throw new Error(`Sheet metadata is missing ${sheetId}`);
  const formulaValues = decodeFormulaValues(formulaPayloads);
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
