#!/usr/bin/env node

import puppeteer from 'puppeteer-core';

const [homeArg] = process.argv.slice(2);
if (!homeArg) {
  console.error('Usage: node tools/list-drive-docs-background.mjs <drive-home-url>');
  process.exit(1);
}
const homeUrl = new URL(homeArg);
if (!/(^|\.)feishu\.cn$|(^|\.)larksuite\.com$|(^|\.)larkoffice\.com$/i.test(homeUrl.hostname)) {
  throw new Error(`Unsupported Feishu/Lark host: ${homeUrl.hostname}`);
}

const port = Number(process.env.AI_CHROME_PORT || 9222);
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const browser = await puppeteer.connect({
  browserWSEndpoint: version.webSocketDebuggerUrl,
  defaultViewport: null,
});
const browserSession = await browser.target().createCDPSession();
const { targetId } = await browserSession.send('Target.createTarget', {
  url: homeUrl.href,
  background: true,
});
const target = await browser.waitForTarget((item) => item._targetId === targetId, { timeout: 5000 });
const page = await target.page();

try {
  const session = await page.createCDPSession();
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.waitForSelector('[data-selector="workspace-next-create_new_file"]', { timeout: 20000 });
  await new Promise((done) => setTimeout(done, 500));
  const documents = await page.evaluate((origin) => {
    const seen = new Set();
    return [...document.querySelectorAll('[data-node-uid*="wikiToken="]')]
      .map((element) => {
        const uid = element.getAttribute('data-node-uid') || '';
        const token = /(?:^|&)wikiToken=([^&]+)/.exec(uid)?.[1];
        const title = (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ');
        return { title, url: token ? `${origin}/wiki/${token}` : null };
      })
      .filter((item) => item.title && item.url && !seen.has(item.url) && seen.add(item.url));
  }, homeUrl.origin);
  console.log(JSON.stringify(documents, null, 2));
} finally {
  await page.close().catch(() => {});
  browser.disconnect();
}
