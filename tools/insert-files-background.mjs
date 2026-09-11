#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { extractClientVars } from '../lib/ssr.mjs';

const [urlArg, anchorText, ...fileArgs] = process.argv.slice(2);
if (!urlArg || !anchorText || !fileArgs.length) {
  console.error('Usage: node tools/insert-files-background.mjs <doc-url> <insert-before-text> <file...>');
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
const files = fileArgs.map((item) => resolve(item));
for (const file of files) {
  if (!existsSync(file)) throw new Error(`Source file does not exist: ${file}`);
}

const port = Number(process.env.AI_CHROME_PORT || 9223);
const expectedExisting = Number(process.env.EXPECTED_EXISTING_FILES || 0);
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

async function fetchFileBlocks() {
  const { cookies } = await pageSession.send('Network.getCookies', { urls: [url.href, url.origin] });
  const cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ');
  const response = await fetch(url.href, {
    headers: { cookie, referer: url.href, 'user-agent': 'Mozilla/5.0' },
  });
  if (!response.ok) throw new Error(`Document preflight failed: HTTP ${response.status}`);
  const raw = extractClientVars(await response.text());
  const data = raw ? JSON.parse(raw).data : null;
  return Object.entries(data?.block_map || {})
    .filter(([, block]) => block.data?.type === 'file')
    .map(([blockId, block]) => ({ blockId, name: block.data.file?.name || null }));
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

async function pressShortcut(keys, key) {
  for (const item of keys) await page.keyboard.down(item);
  await page.keyboard.press(key);
  for (const item of [...keys].reverse()) await page.keyboard.up(item);
}

async function undoTwice() {
  await page.keyboard.press('Escape');
  await pressShortcut(['Meta'], 'z');
  await sleep(200);
  await pressShortcut(['Meta'], 'z');
  await sleep(500);
}

async function openFileMenu(editor) {
  await editor.click();
  await sleep(200);
  await page.keyboard.press('End');
  await sleep(200);
  await page.keyboard.press('Enter');
  await sleep(300);
  await page.keyboard.press('Slash');
  await page.waitForFunction(() => [...document.querySelectorAll('.menu-text')]
    .some((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0
        && (element.innerText || element.textContent || '').trim() === 'Video or File';
    }), {
    timeout: 10000,
  });
}

async function waitForDocumentStable() {
  await page.waitForFunction(() => {
    const header = document.querySelector('.note-title');
    const saving = /Saving\.\.\.|Saving…/.test(header?.innerText || header?.textContent || '');
    const standaloneSlash = [...document.querySelectorAll('.zone-container.text-editor')]
      .some((element) => (element.innerText || element.textContent || '')
        .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '').trim() === '/');
    return header && !saving && !standaloneSlash;
  }, { timeout: 30000 });
  await sleep(1500);
}

try {
  await page.waitForSelector('.page-block.root-block', { timeout: 30000 });
  await sleep(8000);
  await waitForDocumentStable();

  const before = await fetchFileBlocks();
  if (before.length !== expectedExisting) {
    throw new Error(`Expected ${expectedExisting} existing file blocks, found ${before.length}.`);
  }

  for (const file of [...files].reverse()) {
    let menuOpen = false;
    let lastError = null;
    for (let attempt = 0; attempt < 2 && !menuOpen; attempt += 1) {
      const editor = await findAnchorEditor();
      if (!editor) throw new Error(`Insert anchor not found: ${anchorText}`);
      try {
        await openFileMenu(editor);
        menuOpen = true;
      } catch (error) {
        lastError = error;
        await undoTwice();
      }
    }
    if (!menuOpen) throw lastError;
    const chooserPromise = page.waitForFileChooser({ timeout: 8000 });
    let chooser;
    try {
      await page.keyboard.type('file', { delay: 100 });
      await sleep(500);
      await page.keyboard.press('Enter');
      chooser = await chooserPromise;
    } catch (error) {
      await undoTwice();
      throw error;
    }
    await chooser.accept([file]);
    await sleep(3500);
    console.log(`Submitted ${file}`);
  }

  const expectedTotal = expectedExisting + files.length;
  let blocks = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    blocks = await fetchFileBlocks();
    if (blocks.length === expectedTotal) break;
    await sleep(1500);
  }
  if (blocks.length !== expectedTotal) {
    throw new Error(`Expected ${expectedTotal} saved file blocks, found ${blocks.length}.`);
  }
  console.log(JSON.stringify({ inserted: files.length, total: blocks.length, files: blocks.map((item) => item.name) }));
} finally {
  await page.close().catch(() => {});
  browser.disconnect();
}
