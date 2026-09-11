#!/usr/bin/env node

import puppeteer from 'puppeteer-core';
import { extractClientVars } from '../lib/ssr.mjs';

const [urlArg, leftText, rightText] = process.argv.slice(2);
if (!urlArg || !leftText || !rightText) {
  console.error('Usage: node tools/fill-columns-background.mjs <doc-url> <left-text> <right-text>');
  process.exit(1);
}

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

async function readback() {
  const { cookies } = await session.send('Network.getCookies', { urls: [url.href, url.origin] });
  const response = await fetch(url.href, {
    headers: { cookie: cookies.map((item) => `${item.name}=${item.value}`).join('; ') },
  });
  const raw = extractClientVars(await response.text());
  const blockMap = raw ? JSON.parse(raw).data?.block_map || {} : {};
  return {
    left: JSON.stringify(blockMap).includes(leftText),
    right: JSON.stringify(blockMap).includes(rightText),
    grids: Object.values(blockMap).filter((block) => block.data?.type === 'grid').length,
    columns: Object.values(blockMap).filter((block) => block.data?.type === 'grid_column').length,
  };
}

try {
  await page.waitForSelector('[data-block-type="grid"]', { timeout: 30000 });
  await sleep(8000);
  const editors = await page.$$('[data-block-type="grid"] .grid-column-block .zone-container.text-editor');
  if (editors.length < 2) throw new Error(`Expected two column editors, found ${editors.length}.`);
  for (const [editor, value] of [[editors[0], leftText], [editors[1], rightText]]) {
    await editor.click();
    await session.send('Input.insertText', { text: value });
    await sleep(800);
  }
  let result = await readback();
  for (let attempt = 0; attempt < 15 && (!result.left || !result.right); attempt += 1) {
    await sleep(1000);
    result = await readback();
  }
  if (!result.left || !result.right) throw new Error('Column text did not persist.');
  console.log(JSON.stringify(result));
} finally {
  await page.close().catch(() => {});
  browser.disconnect();
}
