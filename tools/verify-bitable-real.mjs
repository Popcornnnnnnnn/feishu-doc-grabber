// Real-tenant verification: run exportBitableCSV against the logged-in AI
// Chrome session and write the resulting CSVs to tests/generated/bitable-real/.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { exportBitableCSV, validateDocumentURL } from '../extension/exporter.mjs';

const output = resolve(import.meta.dirname, '../tests/generated/bitable-real');
await mkdir(output, { recursive: true });
const { webSocketDebuggerUrl } = await fetch('http://127.0.0.1:9222/json/version').then((r) => r.json());
const browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, defaultViewport: null });
const page = (await browser.pages()).find((candidate) => candidate.url().includes('wikcn2MTdBg2ymXjN8bYQYbK80p'));
if (!page) throw new Error('Open the Bitable tab in the AI Chrome first.');

const sourceUrl = page.url();
const fetchInPage = (url, options = {}) => page.evaluate(async ({ url, options }) => {
  const headers = { ...options.headers };
  if (options.method === 'POST') {
    const csrf = document.cookie.split(';').map((part) => part.trim())
      .find((part) => part.startsWith('_csrf_token=') || part.startsWith('swp_csrf_token='));
    if (csrf) headers['x-csrftoken'] = decodeURIComponent(csrf.slice(csrf.indexOf('=') + 1));
  }
  const response = await fetch(url, { credentials: 'include', ...options, headers });
  const text = await response.text();
  if (response.status === 401) throw new Error('session expired');
  if (text.trimStart().startsWith('<')) throw new Error('received an HTML page instead of JSON');
  return text;
}, { url, options });

const transport = {
  request: fetchInPage,
  bitableTables: () => page.evaluate(() => [...document.querySelectorAll('.bitable-new-table-item')].map((element) => ({
    id: (/bitable-new-table-item-([A-Za-z0-9]+)/.exec(element.className) || [])[1],
    name: (element.querySelector('.bitable-new-table-tab__item-name')?.textContent || '').trim(),
  })).filter((table) => table.id)),
};

const files = Object.create(null);
let totalBytes = 0;
const issues = [];
const result = await exportBitableCSV({
  url: validateDocumentURL(sourceUrl),
  sourceQuery: new URL(sourceUrl).searchParams,
  appToken: 'bascnZdYEWYWriytlHsCdsFBEmd',
  hintedTitle: '需求及 Bug 管理',
  transport,
  signal: new AbortController().signal,
  stage: ({ message }) => console.log(`  … ${message}`),
  json: async (path) => JSON.parse(await fetchInPage(path)),
  postJSON: async (path, body) => JSON.parse(await fetchInPage(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  addFile: (name, content) => {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    totalBytes += bytes.byteLength;
    files[name] = bytes;
  },
  issues,
});

for (const [name, bytes] of Object.entries(files)) {
  await mkdir(resolve(output, name, '..'), { recursive: true });
  await writeFile(resolve(output, name), bytes);
  console.log(`saved ${name} (${bytes.byteLength} bytes)`);
}
console.log(`\nverdict: ${result.report.documents[0].integrity.verdict}`);
console.log(`issues: ${issues.length ? issues.join(' | ') : '(none)'}`);
console.log(`total: ${totalBytes} bytes`);
for (const [name, bytes] of Object.entries(files)) {
  if (name.endsWith('.csv')) console.log(`\n===== ${name} (first 15 lines) =====\n${new TextDecoder().decode(bytes).split('\r\n').slice(0, 15).join('\n')}`);
}
browser.disconnect();
