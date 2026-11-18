import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync } from 'fflate';
import { extractAttachmentText, extractDocxText, extractPdfText } from '../lib/attachment.mjs';

function makeDocx(bodyXml) {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`;
  return zipSync({ 'word/document.xml': new TextEncoder().encode(xml) });
}

test('extractDocxText renders headings, lists, entities, and tables in markdown', () => {
  const bytes = makeDocx(`
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>产品手册 &amp; 概述</w:t></w:r></w:p>
    <w:p><w:r><w:t>第一段</w:t><w:tab/><w:t>内容</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>列表项</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>名称</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>值</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1 | 2</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  `);
  const md = extractDocxText(bytes, { format: 'markdown' });
  assert.equal(md, [
    '# 产品手册 & 概述',
    '第一段\t内容',
    '- 列表项',
    '| 名称 | 值 |\n| --- | --- |\n| A | 1 \\| 2 |',
  ].join('\n\n'));

  const txt = extractDocxText(bytes, { format: 'text' });
  assert.equal(txt, [
    '产品手册 & 概述',
    '第一段\t内容',
    '列表项',
    '名称\t值\nA\t1 | 2',
  ].join('\n\n'));
});

test('extractDocxText rejects invalid archives missing word/document.xml', () => {
  const bytes = zipSync({ 'other.txt': new TextEncoder().encode('hello') });
  assert.throws(() => extractDocxText(bytes), /missing word\/document\.xml/);
});

test('extractPdfText handles extracted text and empty scanned PDFs', () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  assert.equal(
    extractAttachmentText(bytes, { filename: 'spec.pdf', pdfExtractor: () => 'Page 1\n\nPage 2' }),
    'Page 1\n\nPage 2',
  );
  assert.match(
    extractPdfText(bytes, { pdfExtractor: () => '   ' }),
    /no extractable text/,
  );
});

test('extractAttachmentText decodes text files and rejects binary files', () => {
  const jsonBytes = new TextEncoder().encode('{"ok":true}');
  assert.equal(extractAttachmentText(jsonBytes, { filename: 'data.json' }), '{"ok":true}');
  assert.equal(extractAttachmentText(new TextEncoder().encode('hi'), { contentType: 'text/plain; charset=utf-8' }), 'hi');
  assert.throws(
    () => extractAttachmentText(new Uint8Array([1, 2, 3]), { filename: 'photo.png', contentType: 'image/png' }),
    /Cannot extract text from binary attachment \(\.png\): photo\.png/,
  );
});

test('extractAttachmentText sniffs PDF and DOCX when filename and content-type are generic', () => {
  const pdfBytes = new TextEncoder().encode('%PDF-1.4\n...');
  assert.equal(
    extractAttachmentText(pdfBytes, { filename: '', contentType: 'application/octet-stream', pdfExtractor: () => 'Sniffed PDF' }),
    'Sniffed PDF',
  );
  const docxBytes = makeDocx('<w:p><w:r><w:t>Sniffed DOCX</w:t></w:r></w:p>');
  assert.equal(
    extractAttachmentText(docxBytes, { filename: '', contentType: 'application/octet-stream' }),
    'Sniffed DOCX',
  );
  const plainZip = zipSync({ 'readme.txt': new TextEncoder().encode('hi') });
  assert.throws(
    () => extractAttachmentText(plainZip, { filename: '', contentType: 'application/octet-stream' }),
    /Cannot extract text from binary attachment/,
  );
});
