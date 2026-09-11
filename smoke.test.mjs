import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { autoScroll } from './lib/scroll.mjs';

test('interactive Chrome scroll and PDF smoke', {
  skip: process.env.FEISHU_BROWSER_SMOKE !== '1' && 'run explicitly with npm run test:browser',
}, async () => {
  const res = await fetch('http://127.0.0.1:9222/json/version');
  const { webSocketDebuggerUrl } = await res.json();
  const browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, defaultViewport: null });
  const page = await browser.newPage();
  try {
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    const result = await autoScroll(page);
    console.log('scroll result:', JSON.stringify(result));
    await page.pdf({ path: '/tmp/smoke.pdf', printBackground: true, format: 'A4' });
    console.log('pdf ok');
  } finally {
    await page.close().catch(() => {});
    await browser.disconnect();
  }
});
