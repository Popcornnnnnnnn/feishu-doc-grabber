#!/usr/bin/env node

import puppeteer from 'puppeteer-core';
import { extractClientVars } from '../lib/ssr.mjs';

const [urlArg, currentText, replacement] = process.argv.slice(2);
if (!urlArg || currentText == null || replacement == null) {
  console.error('Usage: node tools/replace-block-text-background.mjs <doc-url> <current-text> <replacement>');
  process.exit(1);
}
if (!replacement) throw new Error('Replacement must be non-empty so persistence can be verified.');
const url = new URL(urlArg);
if (url.hostname !== process.env.TEST_TENANT_HOST) {
  throw new Error('TEST_TENANT_HOST must exactly match the document hostname.');
}
const port = Number(process.env.AI_CHROME_PORT || 9223);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const browser = await puppeteer.connect({ browserWSEndpoint: version.webSocketDebuggerUrl });
const browserSession = await browser.target().createCDPSession();
const { targetId } = await browserSession.send('Target.createTarget', { url: url.href, background: true });
const target = await browser.waitForTarget((item) => item._targetId === targetId, { timeout: 5000 });
const page = await target.page();
const session = await page.createCDPSession();
await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });

async function containsReplacement() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const { cookies } = await session.send('Network.getCookies', { urls: [url.href, url.origin] });
      const response = await fetch(url.href, {
        headers: { cookie: cookies.map((item) => `${item.name}=${item.value}`).join('; ') },
      });
      const raw = extractClientVars(await response.text());
      if (raw && JSON.stringify(JSON.parse(raw).data?.block_map || {}).includes(replacement)) return true;
    } catch {
      // Feishu can briefly serve a non-SSR shell while the edit is being saved.
    }
    await sleep(500);
  }
  return false;
}

try {
  await page.waitForSelector('.page-block.root-block', { timeout: 30000 });
  await sleep(8000);
  const editors = await page.$$('.zone-container.text-editor');
  let editor = null;
  for (const candidate of editors) {
    const exact = await candidate.evaluate((element, wanted) =>
      (element.innerText || element.textContent || '')
        .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '').trim() === wanted,
    currentText);
    if (exact) {
      editor = candidate;
      break;
    }
  }
  if (!editor) throw new Error(`Exact text block not found: ${currentText}`);
  await editor.click();
  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await session.send('Input.insertText', { text: replacement });
  let saved = false;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await sleep(1000);
    saved = await containsReplacement();
    if (saved) break;
  }
  if (!saved) throw new Error('Replacement did not persist.');
  console.log(JSON.stringify({ currentText, replacement, saved }));
} finally {
  await page.close().catch(() => {});
  browser.disconnect();
}
