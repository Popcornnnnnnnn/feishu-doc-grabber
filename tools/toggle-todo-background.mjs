#!/usr/bin/env node

import puppeteer from 'puppeteer-core';
import { extractClientVars } from '../lib/ssr.mjs';

const [urlArg, todoText] = process.argv.slice(2);
if (!urlArg || !todoText) {
  console.error('Usage: node tools/toggle-todo-background.mjs <doc-url> <todo-text>');
  process.exit(1);
}

const url = new URL(urlArg);
const expectedTenant = process.env.TEST_TENANT_HOST;
if (!expectedTenant || url.hostname !== expectedTenant) {
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

async function readTodo() {
  const { cookies } = await session.send('Network.getCookies', { urls: [url.href, url.origin] });
  const response = await fetch(url.href, {
    headers: { cookie: cookies.map((item) => `${item.name}=${item.value}`).join('; ') },
  });
  if (!response.ok) throw new Error(`Document readback failed: HTTP ${response.status}`);
  const raw = extractClientVars(await response.text());
  const blockMap = raw ? JSON.parse(raw).data?.block_map || {} : {};
  const match = Object.values(blockMap).find((block) =>
    block.data?.type === 'todo' && JSON.stringify(block.data?.text || {}).includes(todoText));
  return match ? { id: match.id, done: Boolean(match.data.done) } : null;
}

try {
  await page.waitForSelector('.page-block.root-block', { timeout: 30000 });
  await sleep(8000);
  const before = await readTodo();
  if (!before) throw new Error(`Todo not found: ${todoText}`);
  const point = await page.evaluate((wanted) => {
    const editor = [...document.querySelectorAll('.zone-container.text-editor')]
      .find((element) => (element.innerText || element.textContent || '').includes(wanted));
    if (!editor?.closest('.docx-todo-block')) return null;
    const box = editor.getBoundingClientRect();
    return { x: box.x - 12, y: box.y + box.height / 2 };
  }, todoText);
  if (!point) throw new Error(`Todo toggle not found: ${todoText}`);
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
  });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
  });

  let after = before;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await sleep(1000);
    after = await readTodo();
    if (after && after.done !== before.done) break;
  }
  if (!after || after.done === before.done) throw new Error('Todo state did not change.');
  console.log(JSON.stringify({ todoText, before, after }));
} finally {
  await page.close().catch(() => {});
  browser.disconnect();
}
