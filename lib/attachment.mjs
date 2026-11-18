import { spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';

const utf8 = new TextDecoder('utf-8', { fatal: false });

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
  'xml', 'html', 'htm', 'log', 'ini', 'conf', 'cfg', 'env',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs',
  'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'bash', 'zsh', 'sql', 'css',
]);

function decodeXmlEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function fileExtension(filename = '') {
  const clean = String(filename).split('?')[0].split('#')[0];
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
}

function isDocx(ext, contentType) {
  return ext === 'docx'
    || contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

function isPdf(ext, contentType) {
  return ext === 'pdf' || contentType.includes('application/pdf');
}

function isTextFile(ext, contentType) {
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (contentType.startsWith('text/')) return true;
  return contentType.includes('application/json')
    || contentType.includes('application/xml')
    || contentType.includes('application/javascript');
}

function extractInlineText(xml) {
  let out = '';
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|(<w:tab\b[^>]*\/?>)|(<w:(?:br|cr)\b[^>]*\/?>)/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    if (match[1] !== undefined) out += decodeXmlEntities(match[1]);
    else if (match[2]) out += '\t';
    else if (match[3]) out += '\n';
  }
  return out;
}

function extractParagraph(pXml, { format = 'markdown' } = {}) {
  const text = extractInlineText(pXml).trim();
  if (!text) return '';
  if (format === 'text') return text;
  const styleMatch = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(pXml);
  const style = styleMatch ? styleMatch[1] : '';
  const headingMatch = /^(?:Heading|heading|标题)\s*([1-6])$/.exec(style) || /^([1-6])$/.exec(style);
  if (headingMatch) return `${'#'.repeat(Number(headingMatch[1]))} ${text}`;
  if (/^Title$/i.test(style)) return `# ${text}`;
  if (/^Subtitle$/i.test(style)) return `## ${text}`;
  if (/<w:numPr\b/.test(pXml)) return `- ${text}`;
  return text;
}

function extractTable(tblXml, { format = 'markdown' } = {}) {
  const rows = [];
  const trRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
  let trMatch;
  while ((trMatch = trRe.exec(tblXml)) !== null) {
    const cells = [];
    const tcRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
    let tcMatch;
    while ((tcMatch = tcRe.exec(trMatch[1])) !== null) {
      const cellParagraphs = [];
      const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
      let pMatch;
      while ((pMatch = pRe.exec(tcMatch[1])) !== null) {
        const line = extractInlineText(pMatch[1]).trim();
        if (line) cellParagraphs.push(line);
      }
      cells.push(cellParagraphs.join(' ').replace(/\s+/g, ' ').trim());
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return '';
  if (format === 'text') return rows.map((row) => row.join('\t')).join('\n');
  const colCount = Math.max(...rows.map((row) => row.length));
  const pad = (row) => Array.from({ length: colCount }, (_, i) => (row[i] ?? '').replace(/\|/g, '\\|'));
  const header = `| ${pad(rows[0]).join(' | ')} |`;
  const sep = `| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`;
  const body = rows.slice(1).map((row) => `| ${pad(row).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

export function extractDocxText(bytes, { format = 'markdown' } = {}) {
  const files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const docEntry = files['word/document.xml'];
  if (!docEntry) throw new Error('Invalid DOCX archive: missing word/document.xml.');
  const xml = utf8.decode(docEntry);
  const bodyMatch = /<w:body\b[^>]*>([\s\S]*?)<\/w:body>/.exec(xml);
  const bodyXml = bodyMatch ? bodyMatch[1] : xml;

  // Walk top-level <w:tbl> and <w:p> in document order without double-counting table paragraphs.
  const blocks = [];
  const tokenRe = /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let match;
  while ((match = tokenRe.exec(bodyXml)) !== null) {
    const chunk = match[0];
    const rendered = chunk.startsWith('<w:tbl')
      ? extractTable(chunk, { format })
      : extractParagraph(chunk, { format });
    if (rendered) blocks.push(rendered);
  }
  return blocks.join('\n\n').trim() || '(empty document)';
}

function defaultPdfExtractor(bytes) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const py = spawnSync('python3', [
    '-c',
    'import io, sys, pypdf\nreader = pypdf.PdfReader(io.BytesIO(sys.stdin.buffer.read()))\nprint("\\n\\n".join((p.extract_text() or "").strip() for p in reader.pages if (p.extract_text() or "").strip()))',
  ], { input, maxBuffer: 50 * 1024 * 1024 });
  if (py.status === 0) return py.stdout.toString('utf8').trim();

  const pdftotext = spawnSync('pdftotext', ['-', '-'], { input, maxBuffer: 50 * 1024 * 1024 });
  if (pdftotext.status === 0) return pdftotext.stdout.toString('utf8').trim();

  throw new Error('PDF text extraction requires python3 with pypdf or pdftotext.');
}

export function extractPdfText(bytes, { pdfExtractor = defaultPdfExtractor } = {}) {
  const text = String(pdfExtractor(bytes) ?? '').trim();
  return text || '(PDF contains no extractable text; it may be scanned images.)';
}

function isPdfSignature(bytes) {
  return bytes.length >= 5
    && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d; // %PDF-
}

function isZipSignature(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function extractAttachmentText(bytes, { filename = '', contentType = '', format = 'markdown', pdfExtractor } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ext = fileExtension(filename);
  const ct = String(contentType).toLowerCase();

  if (isDocx(ext, ct)) return extractDocxText(data, { format });
  if (isPdf(ext, ct)) return extractPdfText(data, { pdfExtractor });
  if (isTextFile(ext, ct)) return utf8.decode(data).trim() || '(empty file)';

  if (!ext) {
    if (isPdfSignature(data)) return extractPdfText(data, { pdfExtractor });
    if (isZipSignature(data)) {
      try {
        return extractDocxText(data, { format });
      } catch {
        // Not a DOCX archive; fall through to unsupported binary error.
      }
    }
  }

  throw new Error(`Cannot extract text from binary attachment${ext ? ` (.${ext})` : ''}${filename ? `: ${filename}` : ''}.`);
}
