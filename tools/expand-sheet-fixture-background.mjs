#!/usr/bin/env node

import puppeteer from 'puppeteer-core';

const [urlArg] = process.argv.slice(2);
if (!urlArg) {
  console.error('Usage: node tools/expand-sheet-fixture-background.mjs <doc-url>');
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
await session.send('Page.setWebLifecycleState', { state: 'active' });

async function clickMenuItem(label) {
  const found = await page.waitForFunction((wanted) => [...document.querySelectorAll('body *')].some((element) => {
    const box = element.getBoundingClientRect();
    const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    return box.width > 0 && box.height > 0 && text === wanted;
  }), { timeout: 8000 }, label).then(() => true).catch(() => false);
  if (!found) {
    const tail = await page.evaluate(() => (document.body?.innerText || '').slice(-1500));
    throw new Error(`Sheet menu item not found: ${label}\n${tail}`);
  }
  const point = await page.evaluate((wanted) => {
    const candidates = [...document.querySelectorAll('body *')].filter((element) => {
      const box = element.getBoundingClientRect();
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      return box.width > 0 && box.height > 0 && text === wanted;
    });
    const element = candidates.find((candidate) => ![...candidate.children].some((child) => {
      const box = child.getBoundingClientRect();
      const text = (child.innerText || child.textContent || '').replace(/\s+/g, ' ').trim();
      return box.width > 0 && box.height > 0 && text === wanted;
    })) || candidates.at(-1);
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, label);
  await page.mouse.click(point.x, point.y);
  await sleep(350);
}

async function openContextMenu(x, y, label) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.mouse.click(x, y, { button: 'right' });
    await sleep(700);
    const opened = await page.evaluate((wanted) => (document.body?.innerText || '')
      .replace(/\s+/g, ' ').includes(wanted), label);
    if (opened) return;
    await page.keyboard.press('Escape');
    await sleep(300);
  }
  throw new Error(`Could not open sheet context menu for ${label}.`);
}

try {
  await page.waitForSelector('[data-block-type="sheet"]', { timeout: 30000 });
  await sleep(10000);
  const blocks = await page.$$('[data-block-type="sheet"]');
  const block = blocks.at(-1);
  await block.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await sleep(800);
  const box = await block.boundingBox();
  await page.mouse.click(box.x + 52, box.y + 37, { clickCount: 2, delay: 100 });
  await page.waitForFunction(() => (document.body?.innerText || '').includes('Merge Cells'), {
    timeout: 15000,
  });
  await sleep(5000);

  await openContextMenu(box.x + 265, box.y + 12, 'Insert Right');
  await page.mouse.click(box.x + 374, box.y - 59, { clickCount: 3, delay: 80 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type('9');
  await page.mouse.click(box.x + 439, box.y - 59);
  await sleep(1500);

  const expandedBox = await block.boundingBox();
  await openContextMenu(expandedBox.x - 12, expandedBox.y + 61, 'Insert Below');
  await page.mouse.click(expandedBox.x + 98, expandedBox.y - 43, { clickCount: 3, delay: 80 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type('11');
  await page.mouse.click(expandedBox.x + 144, expandedBox.y - 43);
  await sleep(5000);
  console.log(JSON.stringify({ insertedColumns: 9, insertedRows: 11 }));
} finally {
  await page.close().catch(() => {});
  browser.disconnect();
}
