import { documentURL } from './daily-chrome.mjs';

const URL_PATTERN = /https?:\/\/[^\s<>"'“”‘’()[\]{}（）【】《》，。、；：！？]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)'"”’\]>]+$/;

/** Extracts unique, validated Feishu/Lark document URLs from pasted links or share text. */
export function extractDocumentURLs(input) {
  const text = String(input ?? '');
  const urls = new Set();
  for (const raw of text.match(URL_PATTERN) ?? []) {
    const candidate = raw.replace(TRAILING_PUNCTUATION, '');
    if (!candidate) continue;
    try {
      urls.add(documentURL(candidate).href);
    } catch {
      // Ignore unrelated URLs embedded in pasted share text; callers reject empty results.
    }
  }
  return [...urls];
}

/** Parses one URL or share-text snippet and fails if no valid Feishu/Lark document link is present. */
export function parseDocumentInput(raw) {
  const urls = extractDocumentURLs(raw);
  if (!urls.length) {
    throw new Error('Use an HTTPS Feishu/Lark docx, wiki, or docs document link.');
  }
  return urls;
}

/** Parses newline-separated URLs or share-text lines, ignoring blanks and # comments. */
export function extractDocumentURLsFromLines(text) {
  const urls = new Set();
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    for (const url of parseDocumentInput(line)) urls.add(url);
  }
  return [...urls];
}
