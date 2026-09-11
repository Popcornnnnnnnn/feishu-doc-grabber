#!/usr/bin/env node

import puppeteer from 'puppeteer-core';
import { extractClientVars } from '../lib/ssr.mjs';

const [urlArg, coordinateArg, value = ''] = process.argv.slice(2);
if (!urlArg || !/^[A-Z]+\d+$/i.test(coordinateArg || '')) {
  console.error('Usage: node tools/set-sheet-cell-background.mjs <doc-url> <cell> <value>');
  process.exit(1);
}
const url = new URL(urlArg);
if (url.hostname !== process.env.TEST_TENANT_HOST) {
  throw new Error('TEST_TENANT_HOST must exactly match the document hostname.');
}
const coordinate = coordinateArg.toUpperCase();
const match = /^([A-Z]+)(\d+)$/.exec(coordinate);
const column = [...match[1]].reduce((result, character) => result * 26 + character.charCodeAt(0) - 64, 0) - 1;
const row = Number(match[2]) - 1;
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
await session.send('Page.setWebLifecycleState', { state: 'active' });

async function documentSummary() {
  const { cookies } = await session.send('Network.getCookies', { urls: [url.href, url.origin] });
  const response = await fetch(url.href, {
    headers: { cookie: cookies.map((item) => `${item.name}=${item.value}`).join('; ') },
  });
  const raw = extractClientVars(await response.text());
  if (!raw) throw new Error('Document readback did not contain clientVars.');
  const data = JSON.parse(raw).data || {};
  const blockMap = data.block_map || {};
  const pageBlock = Object.values(blockMap).find((block) => block.data?.type === 'page');
  return {
    count: Object.keys(blockMap).length,
    title: Object.values(data.meta_map || {}).find((meta) => meta?.page_id === pageBlock?.id)?.title || null,
    sheets: Object.values(blockMap).filter((block) => block.data?.type === 'sheet').length,
  };
}

async function selectCell() {
  await page.waitForSelector('.page-block.root-block, .docx-editor, [data-block-id]', { timeout: 30000 });
  await sleep(6000);
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('*')].filter((element) => {
      const style = getComputedStyle(element);
      return element.scrollHeight - element.clientHeight > 100 && element.clientHeight > 150
        && (style.overflowY === 'auto' || style.overflowY === 'scroll');
    }).sort((a, b) => b.scrollHeight - a.scrollHeight);
    for (const element of items.slice(0, 6)) {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  });
  await sleep(2500);
  const blocks = await page.$$('.docx-sheet-block, [data-block-type="sheet"], [class*="sheet-block"]');
  const block = blocks.at(-1);
  if (!block) throw new Error('Sheet block is not rendered.');
  await block.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await sleep(1000);
  const box = await block.boundingBox();
  if (!box) throw new Error('Sheet block has no visible box.');

  await page.mouse.click(box.x + 52, box.y + 37);
  await sleep(500);
  for (let move = 0; move < column; move += 1) await page.keyboard.press('ArrowRight');
  for (let move = 0; move < row; move += 1) await page.keyboard.press('ArrowDown');
  return box;
}

try {
  let box = await selectCell();
  const before = await documentSummary();
  if (before.sheets !== 1) throw new Error(`Expected exactly one sheet block, found ${before.sheets}.`);

  await page.keyboard.type('xx');
  await page.keyboard.press('Enter');
  await sleep(5000);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  box = await selectCell();
  await page.keyboard.type('x');
  await page.keyboard.press('Backspace');
  await session.send('Input.insertText', { text: value });
  await page.keyboard.press('Enter');
  await sleep(8000);

  const after = await documentSummary();
  if (after.count !== before.count || after.title !== before.title || after.sheets !== before.sheets) {
    throw new Error(`Cell edit escaped into the document: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
  if (process.env.SHEET_SCREENSHOT) await page.screenshot({ path: process.env.SHEET_SCREENSHOT });
  console.log(JSON.stringify({ coordinate, value, before, after }));
} finally {
  await page.close().catch(() => {});
  browser.disconnect();
}
