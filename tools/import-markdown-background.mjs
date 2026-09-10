#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const [homeArg, fileArg] = process.argv.slice(2);
if (!homeArg || !fileArg) {
  console.error('Usage: node tools/import-markdown-background.mjs <drive-home-url> <markdown-file>');
  process.exit(1);
}

const homeUrl = new URL(homeArg);
if (!/(^|\.)feishu\.cn$|(^|\.)larksuite\.com$|(^|\.)larkoffice\.com$/i.test(homeUrl.hostname)) {
  throw new Error(`Unsupported Feishu/Lark host: ${homeUrl.hostname}`);
}
const sourceFile = resolve(fileArg);
if (!existsSync(sourceFile)) throw new Error(`Source file does not exist: ${sourceFile}`);
if (!['.md', '.markdown', '.mark'].includes(extname(sourceFile).toLowerCase())) {
  throw new Error('Only Markdown imports are supported.');
}
const expectedTitle = basename(sourceFile, extname(sourceFile));
const port = Number(process.env.AI_CHROME_PORT || 9222);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function clickPoint(session, point) {
  if (!point) throw new Error('Clickable target not found');
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
  });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
  });
}

async function rectForText(page, text) {
  return page.evaluate((wanted) => {
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const candidates = [...document.querySelectorAll('body *')]
      .filter((element) => visible(element) && (element.innerText || '').trim() === wanted);
    const element = candidates.find((candidate) =>
      ![...candidate.children].some((child) => visible(child) && (child.innerText || '').trim() === wanted)
    ) || candidates.at(-1);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, text);
}

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const browser = await puppeteer.connect({
  browserWSEndpoint: version.webSocketDebuggerUrl,
  defaultViewport: null,
});
const browserSession = await browser.target().createCDPSession();
const { targetId } = await browserSession.send('Target.createTarget', {
  url: 'about:blank',
  background: true,
});
const target = await browser.waitForTarget((item) => item._targetId === targetId, { timeout: 5000 });
const page = await target.page();

try {
  page.setDefaultTimeout(8000);
  const session = await page.createCDPSession();
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.goto(homeUrl.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2500);

  const alreadyExists = await page.evaluate((title) =>
    (document.body.innerText || '').split('\n').some((line) => line.trim() === title), expectedTitle);
  if (alreadyExists) throw new Error(`A document named "${expectedTitle}" already exists.`);

  const uploadRect = await page.evaluate(() => {
    const upload = document.querySelectorAll('[data-selector="workspace-next-create_new_file"]')[1];
    if (!upload) return null;
    const box = upload.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  await clickPoint(session, uploadRect);
  await sleep(400);
  await clickPoint(session, await rectForText(page, 'Import as New Docs'));
  await sleep(500);
  await clickPoint(session, await rectForText(page, 'Confirm'));
  await sleep(600);

  const chooserPromise = page.waitForFileChooser({ timeout: 8000 });
  await clickPoint(session, await rectForText(page, 'Markdown'));
  const chooser = await chooserPromise;
  await chooser.accept([sourceFile]);
  await sleep(20000);

  console.log(JSON.stringify({ submitted: true, title: expectedTitle }));
} finally {
  await page.close().catch(() => {});
  browser.disconnect();
}
