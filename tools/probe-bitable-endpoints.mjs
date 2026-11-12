// Verify tablesv3 + records work for the second table; dump fieldMap shape.
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const output = resolve(import.meta.dirname, '../tests/generated/bitable-capture');
const { webSocketDebuggerUrl } = await fetch('http://127.0.0.1:9222/json/version').then((r) => r.json());
const browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, defaultViewport: null });
const page = (await browser.pages()).find((c) => c.url().includes('wikcn2MTdBg2ymXjN8bYQYbK80p'));
const app = 'bascnZdYEWYWriytlHsCdsFBEmd';
const tableId = 'tblxZUTcOlGUjXzo';

const metaText = await page.evaluate(async ({ app, tableId }) => {
  const csrf = document.cookie.split(';').map((part) => part.trim())
    .find((part) => part.startsWith('_csrf_token=') || part.startsWith('swp_csrf_token='));
  const headers = { 'content-type': 'application/json' };
  if (csrf) headers['x-csrftoken'] = decodeURIComponent(csrf.slice(csrf.indexOf('=') + 1));
  const response = await fetch(`/space/api/bitable/${app}/tablesv3/`, {
    method: 'POST', credentials: 'include', headers,
    body: JSON.stringify({ tableIDList: [tableId], tablePartitionFlagList: [0], tablePartitionForNoRankFlagList: [], encodingProtocol: { compression: 1, serialization: 0 } }),
  });
  return response.text();
}, { app, tableId });
const payload = JSON.parse(metaText);
await writeFile(resolve(output, 'probe-tablesv3-tblx-raw.json'), metaText);
const blobPath = resolve(output, 'probe-tablesv3-tblx.b64');
await writeFile(blobPath, Object.values(payload.data)[0]);

const decodedJson = await new Promise((resolvePromise, reject) => {
  execFile('python3', ['-c', 'import sys,json,base64,gzip;print(json.dumps(json.loads(gzip.decompress(base64.b64decode(open(sys.argv[1]).read()))), ensure_ascii=False))', blobPath],
    (error, stdout) => (error ? reject(error) : resolvePromise(stdout)));
});
const decoded = JSON.parse(decodedJson);
await writeFile(resolve(output, 'probe-tablesv3-tblx.json'), JSON.stringify(decoded, null, 1));
console.log('meta:', JSON.stringify(decoded.meta));
console.log('root keys:', Object.keys(decoded));
const fieldMap = decoded.fieldMap || {};
for (const [fld, field] of Object.entries(fieldMap).slice(0, 8)) {
  const options = field.property?.options || field.property?.typeOptions || null;
  console.log(`${fld} → ${field.name} | type ${field.type} | options: ${JSON.stringify(options)?.slice(0, 140)}`);
}
console.log('views:', Object.entries(decoded.viewMap || {}).map(([id, view]) => `${id}:${view.name}:type${view.type}`));

const records = await page.evaluate(async ({ app, tableId }) => {
  const viewId = 'vewUHHFITx';
  const response = await fetch(`/space/api/v1/bitable/${app}/records?tableId=${tableId}&viewId=${viewId}&tableRev=8&depRev=%7B%7D&viewLazyLoad=true&offset=0&limit=3000&tableID=${tableId}&viewID=${viewId}&removeFmlExtra=true`, { credentials: 'include' });
  return response.text();
}, { app, tableId });
await writeFile(resolve(output, 'probe-records-tblx.json'), records);
console.log(`records tblx: HTTP, ${records.length} bytes, head: ${records.slice(0, 100)}`);
browser.disconnect();
