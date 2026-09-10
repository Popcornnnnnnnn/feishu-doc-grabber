#!/usr/bin/env node
/**
 * feishu-doc-grabber
 *
 * Phase A: --format pdf    printToPDF（有局限：宽表格被裁、悬浮层污染，见 PLAN）
 * Phase B: --format md     DOM 提取 → Markdown（默认图片下载到 assets/）
 *          --format html   清洗后的正文 HTML
 * Phase C: --format capture  CDP 录制全部网络响应到 out/capture- 目录，用于定位 block JSON
 *
 * 浏览器: 自动连接/拉起 AI 专属 Chrome 实例（tools/ai-chrome.mjs）
 */

import puppeteer from 'puppeteer-core';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { autoScroll } from './lib/scroll.mjs';
import { IN_PAGE_EXTRACT } from './lib/clean.mjs';
import { htmlToMarkdown, extractClientVars } from './lib/ssr.mjs';
import { evaluateIntegrity } from './lib/integrity.mjs';
import { ensureRunning, reachable, AI_PORT } from './tools/ai-chrome.mjs';

const ALLOWED_HOSTS = /(^|\.)feishu\.cn$|(^|\.)larkoffice\.com$|(^|\.)larksuite\.com$/i;
const ALLOWED_PATH = /^\/(docx|wiki|docs)\//i;

// ---------- CLI ----------

function parseArgs(argv) {
  const args = {
    urls: [], out: join(homedir(), 'Downloads'), list: null,
    format: 'pdf', timeoutMs: 180000, allowFocus: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--list') args.list = argv[++i];
    else if (a === '--format' || a === '-f') args.format = argv[++i];
    else if (a === '--timeout') args.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--allow-focus') args.allowFocus = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args.urls.push(a);
  }
  return args;
}

function usage() {
  console.log(`feishu-doc-grabber

用法:
  grab <url> [--format pdf|md|html|capture] [--out <dir>] [--allow-focus]

  pdf      printToPDF（快，但宽表格可能被裁、可能带浮层 —— Phase A）
  md       DOM 提取转 Markdown，图片下载到 assets/（Phase B）
  html     清洗后的正文 HTML（Phase B）
  capture  录制全部网络响应到 out/capture-*/，用于分析 block JSON（Phase C）

  --allow-focus  允许画板/表格截图时短暂切到 AI Chrome；默认完全后台运行

  grab --list <urls.txt>   批量（每行一个 URL，# 注释）

浏览器: 自动使用 AI 专属 Chrome（独立 profile ~/.ai-chrome-profile）
  aichrome status | open <url> | stop
`);
}

// ---------- Chrome 连接 ----------

async function connect() {
  if (!(await reachable())) {
    console.log('→ AI Chrome 未运行，正在拉起…');
    await ensureRunning();
  }
  const res = await fetch(`http://127.0.0.1:${AI_PORT}/json/version`);
  const { webSocketDebuggerUrl } = await res.json();
  return puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, defaultViewport: null });
}

/** 后台开新页：不抢焦点、不切用户正在看的标签页 */
async function newBgPage(browser) {
  const cdp = await browser.target().createCDPSession();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background: true });
  const target = await browser.waitForTarget((t) => t._targetId === targetId, { timeout: 15000 });
  return target.page();
}

// ---------- URL / 文件名 ----------

function validateUrl(raw) {
  let url;
  try { url = new URL(raw.trim()); } catch { throw new Error(`无法解析 URL: ${raw}`); }
  if (!ALLOWED_HOSTS.test(url.hostname)) throw new Error(`仅支持飞书域名，当前: ${url.hostname}`);
  if (!ALLOWED_PATH.test(url.pathname)) throw new Error(`仅支持 docx/wiki/docs 链接，当前: ${url.pathname}`);
  return url.href;
}

function safeName(title) {
  // 去掉不可见字符（截图里出现过零宽字符污染文件名），再过滤非法字符
  const cleaned = (title || 'untitled')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '')
    .replace(/[\\/:*?"<>|\n\r\t]/g, '_')
    .replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 120) || 'untitled';
}

/** 打开文档页：跳转 → 等 wiki 重定向 → 等编辑器 → 未登录检测 */
async function openDoc(page, url, timeoutMs) {
  page.setDefaultTimeout(timeoutMs);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

  await page.waitForFunction(
    () => /^\/(docx|docs)\//.test(location.pathname),
    { timeout: 30000 }
  ).catch(() => {});

  const curUrl = page.url();
  if (/accounts\.|passport\.|\/login/.test(curUrl)) {
    throw new Error('未登录飞书。请先登录一次: aichrome open https://feishu.cn （登录态会持久保存）');
  }
  // 404 检测：避免把 404 页当文档导出
  const notFound = await page.evaluate(() =>
    /404/.test(document.title) && document.title.length < 20 ||
    /doesn.t exist|页面不存在|文档不存在/.test(document.body?.innerText?.slice(0, 2000) || '')
  ).catch(() => false);
  if (notFound) {
    throw new Error('文档不存在或无权限（404）。请从浏览器地址栏重新复制链接（注意 I/l、O/0 易混字符）');
  }

  await page.waitForSelector(
    ['.render-unit-wrapper', '.docx-editor', '[data-block-id]', '[data-page-id]'].join(', '),
    { timeout: 60000 }
  ).catch(() => console.log('⚠ 未等到已知编辑器节点，继续尝试'));
  return page;
}

async function scrollDoc(page) {
  console.log('→ 自动滚动加载中…');
  const r = await autoScroll(page);
  console.log(`✓ 滚动完成（${(r.elapsedMs / 1000).toFixed(1)}s，未加载图片 ${r.pendingImages}）`);
  return r;
}

async function docTitle(page) {
  return safeName(await page.title());
}

// ---------- Phase A: PDF ----------

async function grabPdf(browser, url, outDir, timeoutMs) {
  const page = await newBgPage(browser);
  try {
    await openDoc(page, url, timeoutMs);
    await scrollDoc(page);
    const title = await docTitle(page);
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `${title}.pdf`);
    await page.emulateMediaType('screen');
    await page.pdf({
      path: file, printBackground: true, preferCSSPageSize: false, format: 'A4',
      margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' }, timeout: 120000,
    });
    console.log(`✓ 已导出: ${file}`);
    return { url, ok: true, file };
  } finally { await page.close().catch(() => {}); }
}

// ---------- 图片下载（走浏览器上下文，自带登录态） ----------

async function downloadImages(browser, pageUrl, images, assetsDir, urlPrefixRewrite) {
  mkdirSync(assetsDir, { recursive: true });
  const cookies = await getCookiesFor(browser, [pageUrl]);
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const map = new Map(); // src -> 相对文件名
  for (const src of images) {
    try {
      const r = await fetch(src, { headers: { cookie, 'user-agent': UA, referer: pageUrl } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 30 * 1024 * 1024) continue;
      const type = r.headers.get('content-type') || 'image/png';
      const ext = type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp'
        : type.includes('gif') ? 'gif' : type.includes('svg') ? 'svg' : 'png';
      const name = createHash('md5').update(src).digest('hex').slice(0, 12) + '.' + ext;
      writeFileSync(join(assetsDir, name), buf);
      map.set(src, join(urlPrefixRewrite, name));
      process.stdout.write(`  🖼 ${map.size}/${images.length}\r`);
    } catch (e) {
      console.warn(`  ⚠ 图片下载失败: ${src.slice(0, 80)} (${e.message})`);
    }
  }
  process.stdout.write('\n');
  return map;
}


// ---------- SSR 直取（Phase C 主路线） ----------

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

function pageTarget(browser) {
  return browser.targets().filter((t) => t.type() === 'page')[0];
}

async function getCookiesFor(browser, urls) {
  const cdp = await pageTarget(browser).createCDPSession();
  const { cookies } = await cdp.send('Network.getCookies', { urls });
  cdp.detach().catch(() => {});
  return cookies;
}

/** wiki token 有大小写变体，直接用变体 token 会 404/空 SSR —— 先调 get_node 规范化。
 *  变体 token 连 get_node 都拒绝（SourceNotExist），此时用易混淆字符（I/l/1/O/0）
 *  生成单字符替换候选逐个试（常见于复制/手抄链接时 I、l 搞混） */
const AMBIG = { I: 'l', l: 'I', 1: 'l', O: '0', 0: 'O', g: 'n', n: 'g' };
function tokenCandidates(token) {
  const out = [token];
  for (let i = 0; i < token.length; i++) {
    const alt = AMBIG[token[i]];
    if (alt && out.length < 24) out.push(token.slice(0, i) + alt + token.slice(i + 1));
  }
  return [...new Set(out)];
}

async function canonicalizeUrl(browser, url) {
  const u = new URL(url);
  const m = u.pathname.match(/^\/wiki\/([A-Za-z0-9]+)/);
  if (!m) {
    const d = u.pathname.match(/^\/docx\/([A-Za-z0-9]+)/);
    return { url, objToken: d ? d[1] : null };
  }
  try {
    const cookies = await getCookiesFor(browser, [url]);
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    for (const cand of tokenCandidates(m[1])) {
      const api = `${u.origin}/space/api/wiki/v2/tree/get_node/?wiki_token=${cand}`;
      const r = await (await fetch(api, { headers: { cookie, 'user-agent': UA } })).json();
      if (r?.code === 0 && r?.data?.wiki_token) {
        const canonical = r.data.wiki_token;
        const objToken = r.data.obj_token || null;
        if (canonical !== m[1]) {
          console.log(`ℹ wiki token 规范化: ${m[1]} → ${canonical}`);
          return { url: url.replace(m[1], canonical), objToken };
        }
        return { url, objToken };
      }
    }
  } catch {}
  return { url, objToken: null };
}

/** 拉取文档评论，输出 markdown 片段（无评论时返回 null） */
async function fetchCommentThreads(browser, objToken, docUrl) {
  if (!objToken) return [];
  const origin = new URL(docUrl).origin;
  const cookies = await getCookiesFor(browser, [`${origin}/`]);
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const csrf = cookies.find((c) => c.name === '_csrf_token')?.value || cookies.find((c) => c.name === 'swp_csrf_token')?.value || '';
  const H2 = { cookie, 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded', referer: `${origin}/`, 'x-csrftoken': csrf };
  const idsResp = await (await fetch(
    `${origin}/space/api/comment/commentid/all?obj_type=22&token=${objToken}&comment_type_list=0&comment_type_list=1&need_comment_relations=true`,
    { method: 'POST', headers: H2 }
  )).json();
  if (idsResp.code !== 0) throw new Error(`commentid/all: ${idsResp.msg}`);
  const relations = idsResp.data?.commentRelations ?? {};
  const ids = Object.keys(relations);
  if (!ids.length) return [];
  const form = new URLSearchParams();
  form.set('obj_type', '22');
  form.set('token', objToken);
  for (const id of ids) form.append('comment_ids', id);
  form.set('need_msg_box_version', 'true');
  form.set('need_reply', 'true');
  form.set('need_reaction', 'true');
  form.set('no_need_comment_relations', 'true');
  const batchResp = await (await fetch(`${origin}/space/api/comment/batch`, {
    method: 'POST', headers: H2, body: form.toString(),
  })).json();
  if (batchResp.code !== 0) throw new Error(`comment/batch: ${batchResp.msg}`);
  const comments = batchResp.data?.comments ?? {};

  const threads = [];
  for (const cid of ids) {
    const rel = relations[cid]?.relation ? Object.values(relations[cid].relation)[0] : null;
    const quote = (comments[cid]?.quote || '').trim();
    const entries = (comments[cid]?.comment_list ?? [])
      .filter((c) => !c.delete_flag && (c.content || '').replace(/<at[^>]*>@[^<]+<\/at>/g, '').trim())
      .map((c, i) => ({
        name: c.name || '匿名',
        time: (c.create_time || '').slice(5, 16),
        content: (c.content || '').replace(/<at[^>]*>@([^<]+)<\/at>/g, '@$1').replace(/\n/g, ' '),
        isReply: i > 0 || (c.reply_id && c.reply_id !== c.comment_id),
      }));
    if (entries.length) threads.push({ blockId: rel?.positionInfo?.blockID || null, quote, entries });
  }
  return threads;
}

/** 评论批注：原句高亮 + 编号上标（跳文末）+ 文末批注区（跳回原文） */
function applyComments(body, threads) {
  if (!threads.length) return body;
  threads.forEach((th, i) => {
    const marker = `\u27E6REF${i}\u27E7`;
    const ref = `<span id="cmt-ref-${i}"><sup><a href="#cmt-note-${i}">\u3010\ud83d\udcac${i + 1}\u3011</a></sup></span>`;
    const q = (th.quote || '').trim();
    // 原句高亮：quote 紧邻标记时，一起替换为 <mark>原句</mark> + 上标
    if (q && body.includes(q + marker)) {
      body = body.split(q + marker).join(`<mark>${q}</mark>${ref}`);
    } else if (body.includes(marker)) {
      body = body.split(marker).join(ref);
    } else {
      body += `\n\n<span id="cmt-ref-${i}"><sup>\u3010\ud83d\udcac${i + 1}\u3011</sup></span>`;
    }
  });
  const notes = threads.map((th, i) => {
    const lines = th.entries
      .map((e, j) => (j > 0 ? '<br>\u21b3 ' : '') + `<b>${e.name}</b>\uff08${e.time}\uff09\uff1a${e.content}`)
      .join('');
    return `<div id="cmt-note-${i}"><b>\ud83d\udcac${i + 1}</b> ${lines} <a href="#cmt-ref-${i}">\u21a9 \u56de\u539f\u6587</a></div>`;
  }).join('\n');
  return body + `\n\n---\n\n## \ud83d\udcac \u8bc4\u8bba\n\n${notes}\n`;
}

/** 用浏览器里的登录态在 Node 侧抓原始 HTML（不经渲染，拿 SSR 全量数据） */
async function fetchHtml(browser, url) {
  // Network.getCookies 只能在 page 级 target 上调，从任意已开标签页取 cookie
  const cookies = await getCookiesFor(browser, [url]);
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const res = await fetch(url, { headers: { cookie, 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } });
  return res.text();
}

/** 下载 SSR 路线解析出的图片与附件 */
async function downloadSsrMedia(browser, url, images, files, assetsDir, outDir) {
  mkdirSync(assetsDir, { recursive: true });
  const u = new URL(url);
  const streamHost = u.hostname.endsWith('larksuite.com') ? 'internal-api-drive-stream.larksuite.com' : 'internal-api-drive-stream.feishu.cn';
  const cookies = await getCookiesFor(browser, [url, `https://${streamHost}/`]);
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const referer = url;
  const map = new Map(); // 占位符 -> 相对路径
  const dl = async (endpoint, token, blockId) => {
    const r = await fetch(`https://${streamHost}/space/api/box/stream/download/${endpoint}/${token}/?mount_node_token=${blockId}&policy=equal`,
      { headers: { cookie, 'user-agent': UA, referer } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
  for (const img of images) {
    try {
      const buf = await dl('v2/cover', img.token, img.blockId);
      const ext = (img.mime.includes('jpeg') ? 'jpg' : img.mime.includes('webp') ? 'webp' : img.mime.includes('gif') ? 'gif' : 'png');
      const file = `${img.token.slice(0, 16)}.${ext}`;
      writeFileSync(join(assetsDir, file), buf);
      map.set(`ssrimg://${img.token}/${img.blockId}`, `assets/${file}`);
      console.log(`  🖼 ${img.name} (${(buf.length / 1024).toFixed(0)}KB)`);
    } catch (e) { console.warn(`  ⚠ 图片下载失败 ${img.token}: ${e.message}`); }
  }
  for (const f of files) {
    try {
      const buf = await dl('all', f.token, f.blockId);
      const name = safeName(f.name) || f.token;
      let file = name, n = 1;
      while (existsSync(join(outDir, file))) file = name.replace(/(\.[^.]*)?$/, m => ` (${n++})${m ?? ''}`);
      writeFileSync(join(outDir, file), buf);
      map.set(`ssrfile://${f.token}/${f.blockId}`, encodeURIComponent(file));
      console.log(`  📎 ${file} (${(buf.length / 1048576).toFixed(1)}MB)`);
    } catch (e) { console.warn(`  ⚠ 附件下载失败 ${f.token}: ${e.message}`); }
  }
  return map;
}

// ---------- Phase B: Markdown / HTML ----------

async function grabExtract(browser, url, outDir, timeoutMs, mode, options = {}) {
  mkdirSync(outDir, { recursive: true });

  // token 规范化（SSR/DOM 两条路线都要用 objToken 拉评论）
  const canon = await canonicalizeUrl(browser, url);
  const canonUrl = canon.url;
  const objToken = canon.objToken;

  // —— 路线 1（Phase C）: SSR 直取，无需打开页面 ——
  if (mode === 'md') {
    console.log('→ SSR 直取（不渲染页面）…');
    let parsed = null, html = '';
    // sheet 的 SSR SVG 服务端存在分钟级波动，多试几种变体
    const forms = [canonUrl, canonUrl + '?chunked=false', canonUrl + '?r=' + Date.now()];
    for (let i = 0; i < forms.length * 2; i++) {
      html = await fetchHtml(browser, forms[i % forms.length]);
      if (/<title>[^<]*404[^<]*<\/title>/.test(html)) {
        throw new Error('文档不存在或无权限（404）。请从浏览器地址栏重新复制链接（注意 I/l、O/0 易混字符），或确认文档未被移动/删除');
      }
      parsed = htmlToMarkdown(html);
      if (parsed?.markdown?.trim()) {
        const hasAllSheets = parsed.sheets.length === 0 || parsed.stats.sheets > 0;
        if (hasAllSheets) break;
        console.log(`  sheet SSR 未就绪（${i + 1}/${forms.length * 2}），重试…`);
      }
    }
    if (parsed?.markdown?.trim()) {
      const rawTitle = parsed.title || /<title>([^<]*)<\/title>/.exec(html)?.[1] || 'untitled';
      const title = safeName(rawTitle).replace(/ - (飞书云文档|Feishu Docs|飞书)$/, '');
      const file = join(outDir, `${title}.md`);
      const parts = parsed.blocks ?? [{ id: null, md: parsed.markdown }];
      const sheetsNeedShot = parsed.sheets.length > 0 && parsed.stats.sheets === 0;
      if (sheetsNeedShot) console.log(`⚠ sheet SVG 不可用，${parsed.sheets.length} 个表格将走截图兜底`);
      // 评论线程（锚点 → 顶层块）
      let threads = [];
      let commentStatus = objToken ? 'checked' : 'unknown';
      let commentError = null;
      let resolveTop = (blockId) => blockId;
      try {
        const cvJson = extractClientVars(html);
        const bmap = cvJson ? JSON.parse(cvJson)?.data?.block_map : null;
        const parentOf = {};
        let pageId = null;
        if (bmap) for (const [id, b] of Object.entries(bmap)) {
          parentOf[id] = b.data?.parent_id ?? null;
          if (b.data?.type === 'page') pageId = id;
        }
        if (bmap) resolveTop = (blockId) => {
          let cur = blockId, guard = 0;
          while (cur && guard++ < 60) {
            const p = parentOf[cur];
            if (!p || p === pageId) return cur;
            cur = p;
          }
          return null;
        };
        threads = await fetchCommentThreads(browser, objToken, canonUrl);
        if (threads.length) console.log(`→ 拉取到评论 ${threads.length} 条，插入到对应段落…`);
      } catch (e) {
        commentStatus = 'failed';
        commentError = e.message;
        console.warn(`⚠ 评论获取失败: ${e.message.slice(0, 80)}`);
      }
      // 评论锚点标记：追加到锚点块所在顶层 part 末尾
      threads.forEach((th, i) => {
        const top = resolveTop(th.blockId);
        const p = parts.find((x) => x.id === top);
        if (p) p.md += ` \u27E6REF${i}\u27E7`;
      });
      let body = parts.map((p) => p.md).join('\n\n');
      let imageCount = 0;
      let attachmentCount = 0;
      let whiteboardCount = 0;
      let sheetFallbackCount = 0;
      const needMedia = parsed.images.length || parsed.files.length || parsed.whiteboards.length || sheetsNeedShot;
      if (needMedia) {
        console.log(`→ 下载图片 ${parsed.images.length} 张 / 附件 ${parsed.files.length} 个 / 画板 ${parsed.whiteboards.length} 块…`);
        const map = await downloadSsrMedia(browser, canonUrl, parsed.images, parsed.files, join(outDir, 'assets'), outDir);
        imageCount = parsed.images.filter((img) => map.has(`ssrimg://${img.token}/${img.blockId}`)).length;
        attachmentCount = parsed.files.filter((item) => map.has(`ssrfile://${item.token}/${item.blockId}`)).length;
        for (const [ph, rel] of map) body = body.split(ph).join(rel);
        if (parsed.whiteboards.length || sheetsNeedShot) {
          let bmap = new Map();
          if (options.allowFocus) {
            bmap = await screenshotCanvasBlocks(browser, canonUrl, parsed.whiteboards, sheetsNeedShot ? parsed.sheets : [], join(outDir, 'assets'));
          } else {
            console.warn('⚠ 后台模式跳过画板/表格截图；如明确允许切换 AI Chrome，可加 --allow-focus');
          }
          whiteboardCount = parsed.whiteboards.filter((item) => bmap.has(`ssrboard://${item.token}/${item.blockId}`)).length;
          sheetFallbackCount = (sheetsNeedShot ? parsed.sheets : []).filter((item) => bmap.has(`ssrsheet://${item.token}/${item.blockId}`)).length;
          for (const [ph, rel] of bmap) body = body.split(ph).join(rel);
          body = body.replace(/!\[(画板|表格)\]\((ssrboard|ssrsheet):\/\/[^)]+\)/g, '> 🎨 $1（截图失败，请在飞书查看）');
        }
      }
      if (mode === 'md') body = applyComments(body, threads);
      writeFileSync(file, `# ${title}\n\n${body}\n`);
      console.log(`✓ SSR 解析成功: 块 ${parsed.stats.blocks}（${JSON.stringify(parsed.stats.types)}），sheet SVG ${parsed.stats.sheets}`);
      if (parsed.stats.hasMore) console.log('⚠ 文档较大，SSR 可能只包含部分块，结果可能不完整（分页拉取待实现）');
      console.log(`✓ 已导出: ${file}`);
      const integrity = evaluateIntegrity({
        route: 'ssr',
        bodyPresent: Boolean(body.trim()),
        pagination: parsed.stats.hasMore ? 'truncated' : 'complete',
        media: {
          images: { expected: parsed.images.length, exported: imageCount },
          attachments: { expected: parsed.files.length, exported: attachmentCount },
          whiteboards: { expected: parsed.whiteboards.length, exported: whiteboardCount },
          sheetFallbacks: { expected: sheetsNeedShot ? parsed.sheets.length : 0, exported: sheetFallbackCount },
        },
        comments: { status: commentStatus, threads: threads.length, error: commentError },
        unknownBlocks: parsed.stats.unknownBlocks,
        blocks: parsed.stats.blocks,
        blockTypes: parsed.stats.types,
      });
      return { url, ok: true, file, integrity };
    }
    console.log('⚠ SSR 数据不可用（可能需要滚动加载），回落 DOM 提取…');
  }

  // —— 路线 2（Phase B）: 打开页面 + 滚动 + DOM 提取 ——
  const page = await newBgPage(browser);
  try {
    await openDoc(page, url, timeoutMs);
    await scrollDoc(page);
    const title = await docTitle(page);
    mkdirSync(outDir, { recursive: true });

    // 评论：先取线程，再把标记注入锚点块（表格内→所在 td，段落→块尾），提取后原位替换
    let threads = [];
    let commentStatus = mode === 'md' && objToken ? 'checked' : mode === 'md' ? 'unknown' : 'not_applicable';
    let commentError = null;
    if (mode === 'md' && objToken) {
      try {
        threads = await fetchCommentThreads(browser, objToken, canonUrl);
        if (threads.length) {
          await page.evaluate((ths) => {
            ths.forEach((th, i) => {
              const el = document.querySelector(`[data-record-id="${th.blockId}"]`);
              if (!el) return;
              const markerText = `\u27E6REF${i}\u27E7`;
              const quote = th.quote || '';
              if (quote) {
                // 原句定位：拆分文本节点，把标记插到原句正后方
                const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                let node;
                while ((node = walker.nextNode())) {
                  const idx = node.textContent.indexOf(quote);
                  if (idx !== -1) {
                    const range = document.createRange();
                    range.setStart(node, idx);
                    range.setEnd(node, idx + quote.length);
                    const span = document.createElement('span');
                    try { range.surroundContents(span); }
                    catch { span.appendChild(range.extractContents()); range.insertNode(span); }
                    const marker = document.createElement('span');
                    marker.textContent = markerText;
                    span.after(marker);
                    return;
                  }
                }
              }
              // 原句定位失败：块尾兜底
              const marker = document.createElement('span');
              marker.textContent = markerText;
              el.appendChild(marker);
            });
          }, threads);
          console.log(`→ 注入评论锚点 ${threads.length} 条`);
        }
      } catch (e) {
        commentStatus = 'failed';
        commentError = e.message;
        console.warn(`⚠ 评论获取失败: ${e.message.slice(0, 80)}`);
      }
    }

    console.log(`→ 提取 DOM（${mode}）…`);
    const data = await page.evaluate(`(${IN_PAGE_EXTRACT})(${JSON.stringify({ mode })})`);

    if (mode === 'md') console.log(`  顶层块 ${data.blockCount}，图片 ${data.images.length}，未知容器签名 ${data.unknowns.length}`);
    if (!data.markdown?.trim() && !data.html?.trim()) throw new Error('提取结果为空（DOM 结构可能变化，需迭代 clean.mjs 规则）');

    // 图片本地化
    let body = mode === 'md' ? data.markdown : data.html;
    const parts = mode === 'md' ? (data.blocks ?? [{ id: null, md: data.markdown }]) : [{ id: null, md: data.html }];
    let imageCount = 0;
    if (data.images.length) {
      console.log(`→ 下载图片 ${data.images.length} 张…`);
      const assetsDir = join(outDir, 'assets');
      const map = await downloadImages(browser, url, data.images, assetsDir, 'assets');
      imageCount = map.size;
      for (const [src, rel] of map) {
        body = body.split(src).join(rel);
      }
    }

    if (mode === 'md') body = applyComments(body, threads);

    let file;
    if (mode === 'md') {
      file = join(outDir, `${title}.md`);
      writeFileSync(file, `# ${data.title.replace(/ - 飞书云文档.*$/, '')}\n\n${body}\n`);
    } else {
      file = join(outDir, `${title}.html`);
      writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>${data.title}</title>
<style>body{max-width:860px;margin:40px auto;padding:0 16px;font-family:-apple-system,sans-serif;line-height:1.7;color:#222}
img{max-width:100%}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px}
pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto}blockquote{border-left:4px solid #ddd;margin:0;padding-left:16px;color:#555}</style>
${body}`);
    }
    console.log(`✓ 已导出: ${file}`);
    if (mode === 'md' && data.unknowns.length) {
      console.log('ℹ 未识别块签名（迭代 clean.mjs 用）:', JSON.stringify(data.unknowns.slice(0, 10)));
    }
    const integrity = evaluateIntegrity({
      route: 'dom',
      bodyPresent: Boolean(body.trim()),
      pagination: 'unknown',
      media: {
        images: { expected: data.images.length, exported: imageCount },
        attachments: { expected: 0, exported: 0 },
        whiteboards: { expected: 0, exported: 0 },
        sheetFallbacks: { expected: 0, exported: 0 },
      },
      comments: { status: commentStatus, threads: threads.length, error: commentError },
      unknownBlocks: data.unknowns.length,
      blocks: data.blockCount,
      blockTypes: null,
    });
    return { url, ok: true, file, integrity };
  } finally { await page.close().catch(() => {}); }
}

/** 画板/表格截图：canvas 渲染的块只能走截图（需 bringToFront，窗口会短暂到前台） */
async function screenshotCanvasBlocks(browser, url, whiteboards, sheets, assetsDir) {
  const page = await newBgPage(browser);
  const map = new Map();
  try {
    await openDoc(page, url, 60000);
    await new Promise((r) => setTimeout(r, 5000));
    await page.bringToFront();
    const els = await page.$$('.docx-whiteboard-block, .docx-sheet-block');
    let wi = 0, si = 0;
    for (const el of els) {
      const isWb = await el.evaluate((e) => e.classList.contains('docx-whiteboard-block')).catch(() => false);
      const list = isWb ? whiteboards : sheets;
      const idx = isWb ? wi++ : si++;
      if (idx >= list.length) continue;
      try {
        await el.evaluate((e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
        await new Promise((r) => setTimeout(r, 6000));
        const kind = isWb ? 'whiteboard' : 'sheet';
        const file = `${kind}-${idx + 1}.png`;
        await el.screenshot({ path: join(assetsDir, file) });
        map.set(`${isWb ? 'ssrboard' : 'ssrsheet'}://${list[idx].token}/${list[idx].blockId}`, `assets/${file}`);
        console.log(`  🎨 ${isWb ? '画板' : '表格'} ${idx + 1} 已截图 → ${file}`);
      } catch (e) { console.warn(`  ⚠ 截图失败: ${e.message.slice(0, 60)}`); }
    }
    return map;
  } finally { await page.close().catch(() => {}); }
}

// ---------- Phase C: 网络录包 ----------

async function grabCapture(browser, url, outDir, timeoutMs) {
  const page = await newBgPage(browser);
  const bodies = [];
  const wsFrames = [];

  // OOPIF（docx/sheet 编辑器是跨进程 iframe）的网络不在主 page session 里，
  // 必须对浏览器级所有 target 各自 attach CDP；新 target（如滚动后加载的 sheet）也要补挂
  const attached = new Set();
  async function attach(target) {
    const turl = target.url();
    if (attached.has(target._targetId)) return;
    attached.add(target._targetId);
    let session;
    try { session = await target.createCDPSession(); } catch { return; }
    try { await session.send('Network.enable'); } catch { return; }
    const meta = new Map();
    session.on('Network.responseReceived', (e) => {
      meta.set(e.requestId, { url: e.response.url, mime: e.response.mimeType, status: e.response.status });
    });
    session.on('Network.webSocketCreated', (e) => meta.set(`ws:${e.requestId}`, { url: e.url }));
    session.on('Network.webSocketFrameReceived', (e) => {
      const m = meta.get(`ws:${e.requestId}`);
      wsFrames.push({ url: m?.url || 'ws@' + turl.slice(0, 60), size: e.response.payloadData.length, body: e.response.payloadData });
    });
    session.on('Network.loadingFinished', async (e) => {
      const m = meta.get(e.requestId);
      if (!m) return;
      try {
        const r = await session.send('Network.getResponseBody', { requestId: e.requestId });
        const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
        bodies.push({ ...m, size: body.length, body });
      } catch { /* 响应体已释放 */ }
    });
    console.log(`  ↳ 挂载网络监听: ${turl.slice(0, 90)}`);
  }
  for (const t of browser.targets()) await attach(t);
  browser.on('targetcreated', (t) => attach(t));

  try {
    await openDoc(page, url, timeoutMs);
    await scrollDoc(page);
    await new Promise((r) => setTimeout(r, 3000)); // 等滚动后的尾流请求

    const title = await docTitle(page);
    const dir = join(outDir, `capture-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    // WS 帧落盘（正文数据大概率在这）
    const wsDir = join(dir, 'ws');
    const wsHits = [];
    if (wsFrames.length) {
      mkdirSync(wsDir, { recursive: true });
      wsFrames.forEach((f, i) => {
        const fname = `ws_${String(i).padStart(4, '0')}.txt`;
        writeFileSync(join(wsDir, fname), f.body);
        wsHits.push({ file: fname, url: f.url.slice(0, 120), size: f.size });
      });
      writeFileSync(join(dir, 'ws-index.jsonl'), wsHits.map((r) => JSON.stringify(r)).join('\n'));
    }

    // 找候选：包含文档标题关键词的 JSON 响应（PLAN 的确认方法）
    const titleKey = title.split(/[ \-–—|]/).filter((w) => w.length > 3).slice(0, 3);
    const index = [];
    let hitCount = 0;
    for (const [i, b] of bodies.entries()) {
      const isJson = b.mime.includes('json') || b.url.includes('/api/');
      if (!isJson || b.size > 8 * 1024 * 1024 || b.size < 100) continue;
      const fname = `${String(i).padStart(4, '0')}_${createHash('md5').update(b.url).digest('hex').slice(0, 8)}.json`;
      writeFileSync(join(dir, fname), b.body);
      const hit = titleKey.some((k) => b.body.includes(k));
      if (hit) hitCount++;
      index.push({ file: fname, url: b.url.slice(0, 300), mime: b.mime, size: b.size, hit });
    }
    writeFileSync(join(dir, 'index.jsonl'), index.map((r) => JSON.stringify(r)).join('\n'));

    console.log(`\n✓ HTTP 响应 ${index.length} 个, WS 帧 ${wsFrames.length} 个 → ${dir}`);
    if (wsFrames.length) {
      // WS 帧里搜内容关键词
      const contentKey = title.replace(/\s+/g, '').slice(0, 6);
      const wsHit = wsFrames.filter((f) => f.body.includes(contentKey));
      console.log(`★ WS 帧含内容关键词「${contentKey}」: ${wsHit.length}/${wsFrames.length}`);
    }
    const hits = index.filter((r) => r.hit);
    console.log(hits.length
      ? `★ ${hits.length} 个响应包含标题关键词（疑似 block 数据）:\n` + hits.map((h) => `   ${h.file}  ${h.size}B  ${h.url.slice(0, 120)}`).join('\n')
      : '未找到含标题关键词的响应，需要人工翻 index.jsonl');
    return { url, ok: true, file: dir };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- 通用 ----------

async function withRetry(fn, times = 2) {
  let lastErr;
  for (let i = 1; i <= times; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      console.warn(`✗ 第 ${i} 次失败: ${e.message}${i < times ? '，重试…' : ''}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.urls.length && !args.list)) { usage(); process.exit(0); }
  if (!['pdf', 'md', 'html', 'capture'].includes(args.format)) throw new Error(`未知格式: ${args.format}`);

  let urls = args.urls.map(validateUrl);
  if (args.list) {
    const lines = readFileSync(args.list, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    urls.push(...lines.map(validateUrl));
  }
  urls = [...new Set(urls)];
  console.log(`共 ${urls.length} 篇 · 格式 ${args.format} · 输出 ${args.out}`);

  const browser = await connect();
  const results = [];
  try {
    for (const url of urls) {
      try {
        const fn = args.format === 'pdf' ? grabPdf
          : args.format === 'capture' ? grabCapture
          : (b, u, o, t) => grabExtract(b, u, o, t, args.format, { allowFocus: args.allowFocus });
        results.push(await withRetry(() => fn(browser, url, args.out, args.timeoutMs)));
      } catch (e) {
        results.push({ url, ok: false, error: e.message });
      }
    }
  } finally {
    browser.disconnect();
  }

  mkdirSync(args.out, { recursive: true });
  const reportFile = join(args.out, 'export-report.json');
  const documents = results.map((result) => ({
    url: result.url,
    output: result.file || null,
    operationalStatus: result.ok ? 'success' : 'failed',
    error: result.error || null,
    integrity: result.integrity || evaluateIntegrity({
      route: args.format,
      bodyPresent: Boolean(result.ok),
      pagination: 'unknown',
      comments: { status: args.format === 'md' ? 'unknown' : 'not_applicable' },
    }),
  }));
  writeFileSync(reportFile, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), documents }, null, 2) + '\n');
  console.log(`完整性报告: ${reportFile}`);

  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  const verdicts = documents.reduce((acc, item) => {
    acc[item.integrity.verdict] = (acc[item.integrity.verdict] || 0) + 1;
    return acc;
  }, {});
  console.log(`\n完成: ${ok.length} 成功, ${fail.length} 失败`);
  console.log(`完整性: ${verdicts.complete || 0} complete, ${verdicts.degraded || 0} degraded, ${verdicts.incomplete || 0} incomplete`);
  if (fail.length) {
    writeFileSync(join(args.out, '_failed.txt'), fail.map((r) => `${r.url}\t${r.error}`).join('\n'));
    console.log(`失败清单: ${join(args.out, '_failed.txt')}`);
    process.exitCode = 1;
  } else if ((verdicts.degraded || 0) + (verdicts.incomplete || 0) > 0) {
    process.exitCode = 2;
  }
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
