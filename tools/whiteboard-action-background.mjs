#!/usr/bin/env node

import puppeteer from 'puppeteer-core';

const [urlArg, action, ...args] = process.argv.slice(2);
if (!urlArg || !action) {
  console.error('Usage: node tools/whiteboard-action-background.mjs <doc-url> <shape|connector|text> ...');
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
const { targetId } = await browserSession.send('Target.createTarget', {
  url: url.href,
  background: true,
});
const target = await browser.waitForTarget((item) => item._targetId === targetId, { timeout: 5000 });
const page = await target.page();
const session = await page.createCDPSession();
await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });

async function openEditor() {
  await page.waitForSelector('[data-block-type="whiteboard"]', { timeout: 30000 });
  await sleep(10000);
  const block = (await page.$$('[data-block-type="whiteboard"]')).at(-1);
  await block.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await sleep(1000);
  const box = await block.boundingBox();
  if (!box) throw new Error('Whiteboard block is not visible.');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.click(x, y);
  await sleep(500);
  await page.mouse.click(x, y, { clickCount: 2, delay: 120 });
  await sleep(2500);
  const isOpen = async () => page.evaluate(() => [...document.querySelectorAll('button')]
    .some((button) => (button.innerText || '').trim() === 'Close'));
  if (!await isOpen()) {
    await page.keyboard.press('Enter');
    await sleep(2500);
  }
  if (!await isOpen()) throw new Error('Whiteboard editor did not open.');
}

async function drag(x1, y1, x2, y2) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 12 });
  await page.mouse.up();
}

try {
  await openEditor();
  if (action === 'shape') {
    const [kind, x1, y1, x2, y2] = args;
    const paletteX = { rectangle: 106, ellipse: 143, diamond: 184 }[kind];
    if (!paletteX) throw new Error(`Unknown shape: ${kind}`);
    await page.mouse.click(48, 187);
    await sleep(400);
    await page.mouse.click(paletteX, 189);
    await drag(Number(x1), Number(y1), Number(x2), Number(y2));
  } else if (action === 'connector') {
    const [x1, y1, x2, y2] = args.map(Number);
    if ([x1, y1, x2, y2].some(Number.isNaN)) throw new Error('Connector coordinates must be numbers.');
    await page.mouse.click(48, 343);
    await sleep(300);
    await drag(x1, y1, x2, y2);
  } else if (action === 'text') {
    const [x, y, value] = args;
    if (!value) throw new Error('Text value is required.');
    await page.mouse.click(48, 238);
    await sleep(300);
    await page.mouse.click(Number(x), Number(y));
    await session.send('Input.insertText', { text: value });
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
  } else {
    throw new Error(`Unknown action: ${action}`);
  }
  await sleep(5000);
  console.log(JSON.stringify({ action, args, submitted: true }));
} finally {
  await page.close().catch(() => {});
  browser.disconnect();
}
