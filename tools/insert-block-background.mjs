#!/usr/bin/env node

import puppeteer from 'puppeteer-core';
import { extractClientVars } from '../lib/ssr.mjs';

const [urlArg, anchorText, command, content = ''] = process.argv.slice(2);
if (!urlArg || !anchorText || !command) {
  console.error('Usage: node tools/insert-block-background.mjs <doc-url> <insert-after-text> <slash-command> [content]');
  process.exit(1);
}

const url = new URL(urlArg);
if (!/(^|\.)feishu\.cn$|(^|\.)larksuite\.com$|(^|\.)larkoffice\.com$/i.test(url.hostname)) {
  throw new Error(`Unsupported Feishu/Lark host: ${url.hostname}`);
}
const expectedTenant = process.env.TEST_TENANT_HOST;
if (!expectedTenant || url.hostname !== expectedTenant) {
  throw new Error('TEST_TENANT_HOST must exactly match the document hostname.');
}

const port = Number(process.env.AI_CHROME_PORT || 9223);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const browser = await puppeteer.connect({
  browserWSEndpoint: version.webSocketDebuggerUrl,
  defaultViewport: null,
});
const browserSession = await browser.target().createCDPSession();
const { targetId } = await browserSession.send('Target.createTarget', {
  url: url.href,
  background: true,
});
const target = await browser.waitForTarget((item) => item._targetId === targetId, { timeout: 5000 });
const page = await target.page();
const pageSession = await page.createCDPSession();
await pageSession.send('Emulation.setFocusEmulationEnabled', { enabled: true });

async function fetchBlockSummary() {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const { cookies } = await pageSession.send('Network.getCookies', { urls: [url.href, url.origin] });
      const cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ');
      const response = await fetch(url.href, {
        headers: { cookie, referer: url.href, 'user-agent': 'Mozilla/5.0' },
      });
      if (!response.ok) throw new Error(`Document readback failed: HTTP ${response.status}`);
      const raw = extractClientVars(await response.text());
      const blockMap = raw ? JSON.parse(raw).data?.block_map || {} : {};
      const types = {};
      for (const block of Object.values(blockMap)) {
        const type = block.data?.type || 'unknown';
        types[type] = (types[type] || 0) + 1;
      }
      return { count: Object.keys(blockMap).length, types };
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw lastError;
}

async function findAnchorEditor() {
  const editors = await page.$$('.zone-container.text-editor');
  for (const editor of editors) {
    const matches = await editor.evaluate(
      (element, wanted) => (element.innerText || element.textContent || '').includes(wanted),
      anchorText,
    );
    if (matches) return editor;
  }
  return null;
}

async function waitForSaved() {
  await page.waitForFunction(() => {
    const title = document.querySelector('.note-title');
    return title && !/Saving\.\.\.|Saving…/.test(title.innerText || title.textContent || '');
  }, { timeout: 30000 });
  await sleep(1500);
}

try {
  await page.waitForSelector('.page-block.root-block', { timeout: 30000 });
  await sleep(25000);
  await waitForSaved();
  const before = await fetchBlockSummary();
  const editor = await findAnchorEditor();
  if (!editor) throw new Error(`Insert anchor not found: ${anchorText}`);

  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(`/${command}`, { delay: 80 });
  await sleep(500);
  const exactCommandVisible = await page.waitForFunction((wanted) => [...document.querySelectorAll('.menu-text')]
    .some((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0
        && (element.innerText || element.textContent || '').trim() === wanted;
    }), { timeout: 3000 }, command).then(() => true).catch(() => false);
  if (!exactCommandVisible) {
    const visibleCommands = await page.evaluate(() => [...document.querySelectorAll('.menu-text')]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      })
      .map((element) => (element.innerText || element.textContent || '').trim())
      .filter(Boolean));
    if (!visibleCommands.length) {
      await page.keyboard.press('Escape');
      await page.keyboard.down('Meta');
      await page.keyboard.press('z');
      await page.keyboard.up('Meta');
      await sleep(500);
      throw new Error(`No slash-command results appeared for ${command}.`);
    }
  }
  await page.keyboard.press('Enter');
  await sleep(800);
  if (content) await pageSession.send('Input.insertText', { text: content });
  await waitForSaved();

  let after = before;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    after = await fetchBlockSummary();
    if (after.count > before.count) break;
    await sleep(1000);
  }
  if (after.count <= before.count) {
    throw new Error(`No saved block appeared after inserting ${command}.`);
  }
  const expectedType = {
    sheet: 'sheet',
    whiteboard: 'whiteboard',
    callout: 'callout',
    todo: 'todo',
    columns: 'grid',
    quote: 'quote_container',
  }[command.toLowerCase()];
  if (expectedType && Number(after.types[expectedType] || 0) <= Number(before.types[expectedType] || 0)) {
    throw new Error(`Block count grew, but no ${expectedType} block was persisted for ${command}.`);
  }
  console.log(JSON.stringify({ command, content, before, after }));
} finally {
  await page.close().catch(() => {});
  browser.disconnect();
}
