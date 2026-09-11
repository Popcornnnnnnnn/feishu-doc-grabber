#!/usr/bin/env node
/**
 * ai-chrome — AI 专属 Chrome 实例管理
 *
 * 独立 user-data-dir（~/.ai-chrome-profile）+ 调试端口 9222，
 * 与日常 Chrome 完全隔离、可同时运行。默认以 headless 模式启动，不显示窗口。
 *
 * 用法:
 *   node tools/ai-chrome.mjs login        # 首次使用：显式打开窗口登录飞书
 *   node tools/ai-chrome.mjs start        # 后台启动实例（已启动则跳过）
 *   node tools/ai-chrome.mjs status       # 查看状态与已开标签页
 *   node tools/ai-chrome.mjs open <url>   # 在实例中打开页面（前台可见，便于手动登录）
 *   node tools/ai-chrome.mjs stop         # 退出实例（登录态保留在磁盘）
 *   node tools/ai-chrome.mjs ensure       # 确保运行中（供其他脚本调用，无输出）
 *
 * 安装后可直接使用 feishu-chrome 命令。
 */

import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

export const AI_PORT = Number(process.env.AI_CHROME_PORT || 9222);
export const AI_PROFILE = process.env.AI_CHROME_PROFILE || join(homedir(), '.ai-chrome-profile');
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

/** 启动 AI 实例（幂等）。默认 headless；只有显式 login/open 才显示窗口。 */
export async function start({ silent = false, headed = false, initialUrl = 'about:blank' } = {}) {
  if (await reachable()) {
    if (!silent) console.log(`✓ AI Chrome 已在运行 (127.0.0.1:${AI_PORT})`);
    return false;
  }
  const chromeArgs = [
    `--user-data-dir=${AI_PROFILE}`,
    `--remote-debugging-port=${AI_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (!headed) chromeArgs.push('--headless=new');
  chromeArgs.push(initialUrl);
  spawn(
    CHROME_BIN,
    chromeArgs,
    { detached: true, stdio: 'ignore' }
  ).unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await reachable()) {
      if (!silent) {
        console.log(`✓ AI Chrome 已${headed ? '可见' : '在后台'}启动 (${AI_PROFILE})`);
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
  let version = await fetch(`http://127.0.0.1:${AI_PORT}/json/version`).then((r) => r.json()).catch(() => null);
  if (version?.['User-Agent']?.includes('HeadlessChrome')) {
    const running = await puppeteer.connect({ browserWSEndpoint: version.webSocketDebuggerUrl });
    await running.close();
    for (let i = 0; i < 20 && await reachable(); i++) await new Promise((r) => setTimeout(r, 100));
    version = null;
  }
  if (!version) {
    await start({ headed: true, initialUrl: url });
    console.log(`✓ 已打开: ${url}`);
    return;
  }
  const { webSocketDebuggerUrl } = version;
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

async function login() {
  await open('https://feishu.cn');
  console.log('★ 请完成登录；关闭窗口后，后续导出会复用登录态并在后台运行');
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
    console.log(`用法: feishu-chrome <login|start|status|open <url>|stop|ensure>`);
  switch (cmd) {
    case 'login': await login(); break;
    case 'start': await start(); break;
    case 'status': await status(); break;
    case 'open': rest[0] ? await open(rest[0]) : (console.log('缺少 URL'), help()); break;
    case 'stop': await stop(); break;
    case 'ensure': await ensureRunning(); break;
    default: help();
  }
}
