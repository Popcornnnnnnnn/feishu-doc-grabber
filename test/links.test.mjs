import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDocumentURLs, extractDocumentURLsFromLines, parseDocumentInput } from '../lib/links.mjs';

test('extractDocumentURLs accepts direct links and strips hashes', () => {
  assert.deepEqual(
    extractDocumentURLs('https://example.feishu.cn/wiki/WikiToken123?from=copylink#section'),
    ['https://example.feishu.cn/wiki/WikiToken123?from=copylink'],
  );
  assert.deepEqual(
    extractDocumentURLs('https://example.larkoffice.com/docx/DocToken456'),
    ['https://example.larkoffice.com/docx/DocToken456'],
  );
});

test('extractDocumentURLs extracts links from Feishu share text, curly quotes, and punctuation', () => {
  const share = '【飞书文档】项目周会纪要（第12期）：https://example.feishu.cn/docx/AbCd1234。点击查看！';
  assert.deepEqual(parseDocumentInput(share), ['https://example.feishu.cn/docx/AbCd1234']);

  const curly = '“https://example.larksuite.com/docs/LegacyDoc1”';
  assert.deepEqual(parseDocumentInput(curly), ['https://example.larksuite.com/docs/LegacyDoc1']);

  const mixed = '参考文档 (https://example.feishu.cn/wiki/TokenA), 以及 https://example.feishu.cn/docx/TokenB! 和重复 https://example.feishu.cn/wiki/TokenA#top';
  assert.deepEqual(parseDocumentInput(mixed), [
    'https://example.feishu.cn/wiki/TokenA',
    'https://example.feishu.cn/docx/TokenB',
  ]);
});

test('parseDocumentInput rejects insecure, lookalike, credential-bearing, and non-document links', () => {
  for (const invalid of [
    '',
    '   ',
    '没有链接的文本',
    'http://example.feishu.cn/docx/Document',
    'https://example.feishu.cn.evil.test/docx/Document',
    'https://user:secret@example.feishu.cn/docx/Document',
    'https://example.feishu.cn/settings',
    'https://example.com/docx/Document',
  ]) {
    assert.throws(() => parseDocumentInput(invalid), /HTTPS Feishu\/Lark/);
  }
});

test('extractDocumentURLsFromLines ignores blanks and comments while validating every line', () => {
  const text = `
# weekly sync
【飞书文档】纪要 https://example.feishu.cn/wiki/Token1

https://example.feishu.cn/docx/Token2
# duplicate below
https://example.feishu.cn/wiki/Token1
`;
  assert.deepEqual(extractDocumentURLsFromLines(text), [
    'https://example.feishu.cn/wiki/Token1',
    'https://example.feishu.cn/docx/Token2',
  ]);

  assert.throws(
    () => extractDocumentURLsFromLines('https://example.feishu.cn/wiki/Token1\nhttps://example.com/docx/Bad\n'),
    /HTTPS Feishu\/Lark/,
  );
});
