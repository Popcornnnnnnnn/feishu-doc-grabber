/**
 * Phase C: 从页面 HTML 直接解析文档内容（不依赖渲染）。
 *
 * 数据源（已在真实文档上验证）:
 * 1. window.DATA.clientVars.data.block_map —— 全部 docx 块（老版 docx 格式，与官方 export_tasks 同源）
 * 2. 内联脚本注入的 ssr-<blockId>-svg —— sheet(电子表格)块的 SSR SVG，<text> 带坐标可重建表格
 *
 * 注意: SSR 是否包含超长文档的完整块树待验证（虚拟渲染可能只给首屏）。
 */

// ---------- 提取原始数据 ----------

/** 从 html 中提取 clientVars JSON（括号配平，避免正则贪婪踩坑） */
export function extractClientVars(html) {
  const key = 'clientVars: Object(';
  const start = html.indexOf(key);
  if (start === -1) return null;
  return extractBalancedJson(html, start + key.length);
}

function extractBalancedJson(s, start) {
  let depth = 0, i = start, inStr = false, esc = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

/** 提取 sheet 块的 SSR SVG: Map<blockId, svgMarkup> */
export function extractSheetSvgs(html) {
  const map = new Map();
  const re = /id="ssr-([\w-]+)-svg"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    const svgStart = html.indexOf('<svg', m.index);
    const svgEnd = html.indexOf('</svg>', svgStart);
    if (svgStart !== -1 && svgEnd !== -1) map.set(id, html.slice(svgStart, svgEnd + 6));
  }
  return map;
}

// ---------- SVG → 表格 ----------

const decodeEntities = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
   .replace(/&#39;/g, "'").replace(/&amp;/g, ' ');

/**
 * 解析 sheet SVG → 二维表（几何法）
 *
 * SSR SVG 里每个单元格都有一个 <rect>（含 transform/x/y/width/height），
 * 合并单元格的 rect 跨多行/多列 —— 由此可精确重建网格：
 *   1. rect 顶边 y 集合 → 行边界；rect 左边 x 集合 → 列边界
 *   2. 每个 rect 覆盖的行列范围 = 逻辑单元格；跨行/列即为合并单元格
 *   3. 文本按坐标落入对应 rect；合并单元格的值填充到所有被覆盖格子（unmerge carry-fill）
 */
export function svgToTable(svg) {
  const cleaned = svg.replace(/<clipPath[\s\S]*?<\/clipPath>/g, '');

  // ---------- 解析 rect（边框线段）与 text ----------
  const rects = [];
  let m;
  const rectRe = /<rect([^>]*)>/g;
  while ((m = rectRe.exec(cleaned)) !== null) {
    const a = m[1];
    const { tx, ty } = mtx(a);
    const w = numAttr(a, 'width') ?? 0;
    const h = numAttr(a, 'height') ?? 0;
    if (w > 0 && h > 0) rects.push({ x: tx + (numAttr(a, 'x') ?? 0), y: ty + (numAttr(a, 'y') ?? 0), w, h });
  }
  const texts = [];
  const textRe = /<text([^>]*)>([\s\S]*?)<\/text>/g;
  while ((m = textRe.exec(cleaned)) !== null) {
    const a = m[1];
    const { tx, ty } = mtx(a);
    const t = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim();
    if (t) texts.push({ x: tx + (numAttr(a, 'x') ?? 0), y: ty + (numAttr(a, 'y') ?? 0), t });
  }
  if (!rects.length || !texts.length) return null;

  // ---------- 分离横/纵边框线段 ----------
  const hsegs = [];
  const vsegs = [];
  for (const r of rects) {
    if (r.h <= 3 && r.w > 3) hsegs.push({ y: r.y + r.h / 2, x1: r.x, x2: r.x + r.w });
    else if (r.w <= 3 && r.h > 3) vsegs.push({ x: r.x + r.w / 2, y1: r.y, y2: r.y + r.h });
  }
  if (!hsegs.length || !vsegs.length) return null;

  const cluster = (vals, tol) => {
    const s = [...vals].sort((a, b) => a - b);
    const out = [s[0]];
    for (const v of s.slice(1)) if (v - out[out.length - 1] > tol) out.push(v);
    return out;
  };
  const yTop = Math.min(...hsegs.map((s) => s.y), ...vsegs.map((s) => s.y1));
  const yBot = Math.max(...hsegs.map((s) => s.y), ...vsegs.map((s) => s.y2));
  const xL = Math.min(...vsegs.map((s) => s.x), ...hsegs.map((s) => s.x1));
  const xR = Math.max(...vsegs.map((s) => s.x), ...hsegs.map((s) => s.x2));
  const rowB = cluster(hsegs.map((s) => s.y), 3);
  const colB = cluster(vsegs.map((s) => s.x), 3);
  const nR = rowB.length - 1, nC = colB.length - 1;
  if (nR < 1 || nC < 1) return null;

  const covers = (intervals, a, b) => {
    const rel = intervals.filter(([s1, s2]) => s1 <= a + 3 && s2 >= b - 3).sort((p, q) => p[0] - q[0]);
    if (!rel.length) return false;
    let cur = rel[0][0], far = rel[0][1];
    for (const [s1, s2] of rel) {
      if (s1 > far + 3) return false;
      far = Math.max(far, s2);
    }
    return far >= b - 3;
  };
  const hasV = (x, y1, y2) => covers(vsegs.filter((s) => Math.abs(s.x - x) <= 3).map((s) => [s.y1, s.y2]), y1, y2);
  const hasH = (y, x1, x2) => covers(hsegs.filter((s) => Math.abs(s.y - y) <= 3).map((s) => [s.x1, s.x2]), x1, x2);

  // ---------- union-find：无分隔线的相邻格子 = 合并单元格 ----------
  const id = (r, c) => r * nC + c;
  const parent = Array.from({ length: nR * nC }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  for (let r = 0; r < nR; r++) {
    for (let c = 0; c < nC; c++) {
      if (c + 1 < nC && !hasV(colB[c + 1], rowB[r], rowB[r + 1])) union(id(r, c), id(r, c + 1));
      if (r + 1 < nR && !hasH(rowB[r + 1], colB[c], colB[c + 1])) union(id(r, c), id(r + 1, c));
    }
  }

  // ---------- 文本归入合并区域，输出区域矩形（含跨行/跨列信息） ----------
  const regionTexts = new Map();
  for (const t of texts) {
    let r = 0; for (let i = 0; i < nR; i++) if (t.y >= rowB[i] - 1) r = i;
    let c = 0; for (let i = 0; i < nC; i++) if (t.x >= colB[i] - 1) c = i;
    const root = find(id(r, c));
    if (!regionTexts.has(root)) regionTexts.set(root, []);
    regionTexts.get(root).push({ r, c, t: t.t });
  }

  const regions = []; // {r,c,rs,cs,text}
  for (const [root, ts] of regionTexts) {
    ts.sort((a, b) => a.r - b.r || a.c - b.c);
    const rs = ts.map((x) => x.r), cs = ts.map((x) => x.c);
    const text = ts.map((x) => x.t).join('\n');
    regions.push({
      r: Math.min(...rs), c: Math.min(...cs),
      rs: Math.max(...rs) - Math.min(...rs) + 1,
      cs: Math.max(...cs) - Math.min(...cs) + 1,
      text,
    });
  }
  // 剔除飞书定位栏: 列字母行（rowB[0] 上方的区域）/ 行号列
  const filtered = regions.filter((g) => g.r > 0 || g.c > 0);
  const lettersRow = regions.filter((g) => g.r === 0 && g.text.split('\n').every((x) => /^[A-Z]{1,2}$/.test(x)));
  if (lettersRow.length) {
    const keep = regions.filter((g) => g.r !== 0);
    for (const g of keep) if (g.r > 0) g.r -= 1;
    return finalize(keep, nR - 1, nC);
  }
  return finalize(regions, nR, nC);

  function finalize(regs, rows, cols) {
    // 剔除行号列（全数字且最左）
    const col0 = regs.filter((g) => g.c === 0);
    if (col0.length && col0.length === regs.length && col0.every((g) => /^\d+$/.test(g.text.split('\n')[0]))) {
      regs = regs.map((g) => ({ ...g, c: g.c - 1 })).filter((g) => g.c >= 0);
      cols -= 1;
    }
    return { rows, cols, regions: regs };
  }
}

/** 区域对象 → 带 rowspan/colspan 的 HTML 表格 */
export function buildHtmlTable(tableObj) {
  if (!tableObj?.regions?.length) return '';
  const { rows, cols, regions } = tableObj;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const occ = Array.from({ length: rows }, () => Array(cols).fill(false));
  const at = new Map(); // 'r,c' -> region（锚点在左上角）
  for (const g of regions) {
    for (let r = g.r; r < Math.min(g.r + g.rs, rows); r++) {
      for (let c = g.c; c < Math.min(g.c + g.cs, cols); c++) {
        if (r >= 0 && c >= 0) { occ[r][c] = true; if (r === g.r && c === g.c) at.set(r + ',' + c, g); }
      }
    }
  }
  const out = ['<table>'];
  for (let r = 0; r < rows; r++) {
    out.push('<tr>');
    for (let c = 0; c < cols; c++) {
      const g = at.get(r + ',' + c);
      if (g) {
        const span = (g.rs > 1 ? ` rowspan="${g.rs}"` : '') + (g.cs > 1 ? ` colspan="${g.cs}"` : '');
        out.push(`<td${span}>${esc(g.text).replace(/\n/g, '<br>')}</td>`);
      } else if (!occ[r][c]) {
        out.push('<td></td>');
      }
    }
    out.push('</tr>');
  }
  out.push('</table>');
  return out.join('\n');
}

function numAttr(attrs, name) {
  const m = attrs.match(new RegExp(`${name}="([\\d.\\-]+)"`));
  return m ? parseFloat(m[1]) : null;
}
function mtx(attrs) {
  const m = attrs.match(/matrix\([^)]*\)/);
  if (!m) return { tx: 0, ty: 0 };
  const v = m[0].match(/[\d.\-]+/g)?.map(Number) ?? [];
  return v.length >= 6 ? { tx: v[4], ty: v[5] } : { tx: 0, ty: 0 };
}


// ---------- block_map → Markdown ----------

const textOf = (b) => {
  const t = b.data?.text;
  if (!t) return '';
  const texts = t.initialAttributedTexts?.text ?? {};
  return Object.keys(texts).sort((a, b2) => a - b2).map((k) => texts[k]).join('')
    .replace(/\u200B-\u200F\uFEFF/g, '').trimEnd();
};

export function blockMapToMarkdown(blockMap, sheetSvgs) {
  const page = Object.values(blockMap).find((b) => b.data?.type === 'page');
  if (!page) return null;
  const childrenOf = (id) => (blockMap[id]?.data?.children ?? [])
    .filter((cid) => blockMap[cid]);

  const render = (id, depth) => {
    const b = blockMap[id];
    const d = b.data;
    const kids = childrenOf(id);
    const kidsMd = () => kids.map((k) => render(k, depth)).filter(Boolean).join('\n\n');
    const txt = textOf(b);

    switch (d.type) {
      case 'page': return kidsMd();
      case 'heading1': case 'heading2': case 'heading3':
      case 'heading4': case 'heading5': case 'heading6':
      case 'heading7': case 'heading8': case 'heading9': {
        const lv = Math.min(6, parseInt(d.type.slice(-1), 10));
        return '#'.repeat(lv) + ' ' + txt;
      }
      case 'bullet': {
        const self = txt ? '  '.repeat(depth) + '- ' + txt : '';
        const child = kids.map((k) => render(k, depth + 1)).filter(Boolean).join('\n');
        return self + (self && child ? '\n' : '') + child;
      }
      case 'ordered': {
        const self = txt ? '  '.repeat(depth) + '1. ' + txt : '';
        const child = kids.map((k) => render(k, depth + 1)).filter(Boolean).join('\n');
        return self + (self && child ? '\n' : '') + child;
      }
      case 'check':
        return '  '.repeat(depth) + '- [' + (d.checked ? 'x' : ' ') + '] ' + txt;
      case 'quote':
      case 'quote_container':
        return kidsMd().split('\n').map((l) => '> ' + l).join('\n');
      case 'callout':
        return '> [!NOTE]\n' + kidsMd().split('\n').map((l) => '> ' + l).join('\n');
      case 'code': {
        const lang = (d.language || '').toLowerCase();
        const body = txt || (d.text?.initialAttributedTexts ? textOf(b) : '');
        return '```' + lang + '\n' + body + '\n```';
      }
      case 'hr':
      case 'divider':
        return '---';
      case 'image': {
        const img = d.image || {};
        const name = (img.name || 'image').replace(/\.[a-z]+$/i, '');
        return `![${name}](ssrimg://${img.token}/${id})`;
      }
      case 'file': {
        const f = d.file || {};
        if (!f.token) return '';
        const sz = f.size > 1048576 ? (f.size / 1048576).toFixed(1) + 'MB' : ((f.size || 0) / 1024).toFixed(0) + 'KB';
        return `[📄 ${f.name || f.token} (${sz})](ssrfile://${f.token}/${id})`;
      }
      case 'whiteboard':
      case 'board':
        return d.token ? `![画板](ssrboard://${d.token}/${id})` : '> 🎨 画板块（暂不支持导出，请在飞书查看）';
      case 'sheet': {
        const svg = sheetSvgs.get(b.id);
        const obj = svg ? svgToTable(svg) : null;
        const html = obj ? buildHtmlTable(obj) : '';
        if (html) return html;
        return d.token ? `![表格](ssrsheet://${d.token}/${id})` : '> ⚠️ 表格数据缺失';
      }
      case 'text': default: {
        if (kids.length) {
          const self = txt;
          const child = kids.map((k) => render(k, depth)).filter(Boolean).join('\n\n');
          return self ? self + '\n\n' + child : child;
        }
        return txt;
      }
    }
  };

  return childrenOf(page.id)
    .map((id) => ({ id, md: render(id, 0) }))
    .filter((p) => p.md && p.md.trim());
}

/** 顶层入口: html → { markdown, title, stats } */
export function htmlToMarkdown(html) {
  const cvJson = extractClientVars(html);
  if (!cvJson) return null;
  let cv;
  try { cv = JSON.parse(cvJson); } catch { return null; }
  const data = cv?.data;
  const blockMap = data?.block_map;
  if (!blockMap) return null;
  const sheetSvgs = extractSheetSvgs(html);
  const parts = blockMapToMarkdown(blockMap, sheetSvgs);
  const markdown = parts.map((p) => p.md).join('\n\n');
  const types = {};
  const images = [];
  const files = [];
  const whiteboards = [];
  const sheets = [];
  for (const [bid, b] of Object.entries(blockMap)) {
    types[b.data?.type] = (types[b.data?.type] || 0) + 1;
    if (b.data?.type === 'image' && b.data.image?.token) {
      images.push({ token: b.data.image.token, blockId: bid, name: b.data.image.name || 'image.png', mime: b.data.image.mimeType || 'image/png' });
    }
    if (b.data?.type === 'file' && b.data.file?.token) {
      files.push({ token: b.data.file.token, blockId: bid, name: b.data.file.name || b.data.file.token, mime: b.data.file.mimeType || 'application/octet-stream' });
    }
    if ((b.data?.type === 'whiteboard' || b.data?.type === 'board') && b.data?.token) {
      whiteboards.push({ token: b.data.token, blockId: bid });
    }
    if (b.data?.type === 'sheet' && b.data?.token) {
      sheets.push({ token: b.data.token, blockId: bid });
    }
  }
  // 标题: meta_map 里任意条目的 title（wiki/docx 通用）
  let title = null;
  for (const meta of Object.values(data.meta_map ?? {})) {
    if (meta?.title) { title = meta.title; break; }
  }
  if (!title) {
    const m = html.match(/"title":"([^"]{1,120})"/);
    if (m) title = m[1];
  }
  return {
    markdown,
    blocks: parts,
    title,
    images,
    files,
    whiteboards,
    sheets,
    stats: {
      blocks: Object.keys(blockMap).length,
      types,
      sheets: sheetSvgs.size,
      hasMore: !!data.has_more,   // true 表示 SSR 只给了部分块，需要 cursor 分页（待实现）
    },
  };
}
