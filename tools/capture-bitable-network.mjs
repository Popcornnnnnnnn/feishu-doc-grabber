// Capture Bitable web-API requests/responses from the AI Chrome instance so
// the exporter can be aligned with the real endpoints. Read-only: loads the
// page and saves response bodies to tests/generated/bitable-capture/.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const output = resolve(import.meta.dirname, '../tests/generated/bitable-capture');
await mkdir(output, { recursive: true });
const { webSocketDebuggerUrl } = await fetch('http://127.0.0.1:9222/json/version').then((r) => r.json());
const browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, defaultViewport: null });
const page = (await browser.pages()).find((candidate) => candidate.url().includes('wikcn2MTdBg2ymXjN8bYQYbK80p'))
  ?? await browser.newPage();
const session = await page.createCDPSession();
await session.send('Network.enable');

const pending = new Map();
const captured = [];
session.on('Network.requestWillBeSent', (event) => {
  if (!/bitable|wiki\/api|space\/api/i.test(event.request.url)) return;
  if (/browser\.cn|monitor|collect|beacon|report/i.test(event.request.url)) return;
  pending.set(event.requestId, {
    url: event.request.url,
    method: event.request.method,
    postData: event.request.postData || '',
    headers: event.request.headers,
  });
});
session.on('Network.responseReceived', (event) => {
  const request = pending.get(event.requestId);
  if (request) request.status = event.response.status;
});
session.on('Network.loadingFinished', async (event) => {
  const request = pending.get(event.requestId);
  if (!request || request.status === 304) return;
  try {
    const body = await session.send('Network.getResponseBody', { requestId: event.requestId });
    request.body = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
    captured.push(request);
    pending.delete(event.requestId);
  } catch { /* body evicted */ }
});

await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
await new Promise((done) => setTimeout(done, 12000));

const summary = [];
for (const [index, request] of captured.entries()) {
  const short = request.url.replace(/\?.*$/, '');
  const size = request.body?.length ?? 0;
  summary.push({ url: request.url, method: request.method, status: request.status, bodyBytes: size });
  if (size > 0) {
    const name = `${String(index).padStart(2, '0')}-${short.split('/').filter(Boolean).pop().slice(0, 40)}-${size}.json`;
    await writeFile(resolve(output, name.replace(/[^\w.-]/g, '_')), request.body);
  }
}
await writeFile(resolve(output, '_summary.json'), JSON.stringify(summary, null, 2));
await writeFile(resolve(output, '_requests.json'), JSON.stringify(captured.map(({ url, method, postData, status }) => ({ url, method, status, postData })), null, 2));
console.log(`Captured ${captured.length} API request(s) → ${output}`);
for (const entry of summary) console.log(`${entry.method} ${entry.status} ${String(entry.bodyBytes).padStart(8)}  ${entry.url.slice(0, 130)}`);
browser.disconnect();
