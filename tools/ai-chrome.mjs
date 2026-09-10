#!/usr/bin/env node
/**
 * ai-chrome — AI 专属 Chrome 实例管理
 *
 * 独立 user-data-dir（~/.ai-chrome-profile）+ 调试端口 9222，
 * 与日常 Chrome 完全隔离、可同时运行。首次使用需在其中登录目标站点（如飞书）。
 *
 * 用法:
 *   node tools/ai-chrome.mjs start        # 启动实例（已启动则跳过）
 *   node tools/ai-chrome.mjs status       # 查看状态与已开标签页
 *   node tools/ai-chrome.mjs open <url>   # 在实例中打开页面（前台可见，便于手动登录）
 *   node tools/ai-chrome.mjs stop         # 退出实例（登录态保留在磁盘）
 *   node tools/ai-chrome.mjs ensure       # 确保运行中（供其他脚本调用，无输出）
 *
 * 建议 alias:  alias aichrome="node /path/to/feishu-doc-grabber/tools/ai-chrome.mjs"
 */

import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

export const AI_PORT = 9222;
export const AI_PROFILE = join(homedir(), '.ai-chrome-profile');
export const CHROME_BIN =
  process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function reachable(port = AI_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

/** 启动 AI 实例（幂等）。返回是否为本次新启动。 */
export async function start({ silent = false } = {}) {
  if (await reachable()) {
    if (!silent) console.log('✓ AI Chrome 已在运行 (127.0.0.1:9222)');
    return false;
  }
  const firstRun = !existsSync(AI_PROFILE);
  spawn(
    CHROME_BIN,
    [
      `--user-data-dir=${AI_PROFILE}`,
      `--remote-debugging-port=${AI_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      firstRun ? 'https://feishu.cn' : 'about:blank',
    ],
    { detached: true, stdio: 'ignore' }
  ).unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await reachable()) {
      if (!silent) {
        console.log(`✓ AI Chrome 已启动 (${AI_PROFILE})`);
        if (firstRun) console.log('★ 首次启动：请在打开的窗口中登录飞书，登录态会持久保存');
      }
      return true;
    }
  }
  throw new Error(`AI Chrome 启动失败，请手动执行: "${CHROME_BIN}" --user-data-dir=${AI_PROFILE} --remote-debugging-port=${AI_PORT}`);
}

/** 供脚本调用：确保实例在运行，无输出 */
export async function ensureRunning() {
  return start({ silent: true });
}

async function status() {
  if (!(await reachable())) return console.log('✗ 未运行');
  const targets = await fetch(`http://127.0.0.1:${AI_PORT}/json/list`).then((r) => r.json());
  console.log(`✓ 运行中 (127.0.0.1:${AI_PORT})，profile: ${AI_PROFILE}`);
  console.log(`✓ 标签页:`);
  for (const t of targets) {
    if (t.type !== 'page') continue;
    console.log(`   - ${t.title}  ${t.url}`);
  }
}

async function open(url) {
  await ensureRunning();
  const { webSocketDebuggerUrl } = await fetch(`http://127.0.0.1:${AI_PORT}/json/version`).then((r) => r.json());
  const browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, defaultViewport: null });
  const pages = await browser.pages();
  // 关掉同 URL 的旧标签页，避免堆积
  for (const p of pages) {
    if (p.url() === url) await p.close().catch(() => {});
  }
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.bringToFront();
  browser.disconnect();
  console.log(`✓ 已打开: ${url}`);
}

async function stop() {
  if (!(await reachable())) return console.log('✗ 未运行');
  const { webSocketDebuggerUrl } = await fetch(`http://127.0.0.1:${AI_PORT}/json/version`).then((r) => r.json());
  const browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl });
  await browser.close(); // 优雅退出，登录态保留在 profile
  console.log('✓ 已退出');
}

// ---------- CLI（仅直接运行本文件时执行，被 import 时不执行） ----------

const [cmd, ...rest] = process.argv.slice(2);
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const help = () =>
    console.log(`用法: node tools/ai-chrome.mjs <start|status|open <url>|stop|ensure>`);
  switch (cmd) {
    case 'start': await start(); break;
    case 'status': await status(); break;
    case 'open': rest[0] ? await open(rest[0]) : (console.log('缺少 URL'), help()); break;
    case 'stop': await stop(); break;
    case 'ensure': await ensureRunning(); break;
    default: help();
  }
}
