/**
 * Phase B: DOM 清洗与转换。
 *
 * 导出 IN_PAGE_EXTRACT：注入页面执行的提取函数（mode: 'md' | 'html'）。
 * 原则（对应 PLAN）：按结构（data-* / 标签语义 / 类名关键词）识别块类型，
 * 不依赖混淆 class；只遍历文档编辑器根节点，天然排除水印/工具栏/浮层。
 */

export const IN_PAGE_EXTRACT = `
async ({ mode = 'md' } = {}) => {
  // ---------- 根节点定位：包含全部块的、尽可能高的非 body 节点 ----------
  function pickRoot() {
    const all = document.querySelectorAll('[data-block-id]');
    if (!all.length) return document.body;
    const total = all.length;
    let node = all[0], root = node;
    while (node && node !== document.documentElement) {
      if (node.querySelectorAll('[data-block-id]').length >= total) root = node;
      node = node.parentElement;
    }
    return root;
  }

  const unknownTypes = new Map(); // className 签名 -> count，用于后续迭代规则

  function classify(el) {
    const dt = (el.getAttribute('data-block-type') || '').toLowerCase();
    const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    const tag = el.tagName.toLowerCase();

    const headerLv = (dt.match(/heading(\\d)/) || cls.match(/header(?:-|)(\\d)/) || (el.getAttribute('aria-level') ? [null, el.getAttribute('aria-level')] : null));
    if (headerLv) return { t: 'header', n: Math.min(6, parseInt(headerLv[1], 10) || 1) };
    if (/^table$/.test(tag) || dt.includes('table') || el.querySelector(':scope > table')) return { t: 'table' };
    if (dt.includes('image') || cls.includes('render-unit-image') || (el.querySelector(':scope img') && !el.querySelector(':scope table'))) {
      if (el.querySelector('img')) return { t: 'image' };
    }
    if (dt.includes('bullet') || cls.includes('bullet')) return { t: 'bullet' };
    if (dt.includes('ordered') || cls.includes('ordered') || cls.includes('number-list')) return { t: 'ordered' };
    if (dt.includes('todo') || cls.includes('todo') || el.querySelector(':scope > .checkbox, :scope input[type=checkbox]')) return { t: 'todo' };
    if (dt.includes('quote')) return { t: 'quote' };
    if (dt.includes('callout')) return { t: 'callout' };
    if (dt.includes('code') || cls.includes('render-unit-code') || el.querySelector(':scope pre, :scope .code-block')) return { t: 'code' };
    if (dt.includes('divider') || cls.includes('divider') || tag === 'hr') return { t: 'divider' };
    if (dt.includes('grid') || dt.includes('column') || dt.includes('view') || dt.includes('container') || dt.includes('page')) return { t: 'container' };
    if (el.querySelector(':scope [data-block-id]')) {
      if (!unknownTypes.has('container:' + cls.slice(0, 60))) unknownTypes.set('container:' + cls.slice(0, 60), 0);
      unknownTypes.set('container:' + cls.slice(0, 60), unknownTypes.get('container:' + cls.slice(0, 60)) + 1);
      return { t: 'container' };
    }
    return { t: 'text' };
  }

  // 直接子块：穿过非块包裹层，且最近的块祖先必须是 el 本身
  function childBlocks(el) {
    const out = [];
    for (const c of el.children) {
      if (c.matches && c.matches('[data-block-id]')) out.push(c);
      else out.push(...c.querySelectorAll('[data-block-id]'));
    }
    return out.filter((b) => {
      let p = b.parentElement;
      while (p && p !== el) {
        if (p.hasAttribute('data-block-id')) return false;
        p = p.parentElement;
      }
      return true;
    });
  }

  function inline(node) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.textContent; continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      const cls = typeof n.className === 'string' ? n.className : '';
      if (tag === 'script' || tag === 'style') continue;
      if (tag === 'br') { out += ' '; continue; }
      if (tag === 'img') { const isrc = n.getAttribute('src') || ''; if (isrc.startsWith('data:')) continue; out += '![](' + isrc + ')'; continue; }
      if (tag === 'code' || /inline-code/i.test(cls)) { out += '\u0060' + inline(n).trim() + '\u0060'; continue; }
      if (/^(b|strong)$/.test(tag) || /bold|strong/i.test(cls)) { const s = inline(n).trim(); out += s ? '**' + s + '**' : ''; continue; }
      if (/^(i|em)$/.test(tag) || /italic/i.test(cls)) { const s = inline(n).trim(); out += s ? '*' + s + '*' : ''; continue; }
      if (/^(s|strike|del)$/.test(tag) || /strike/i.test(cls)) { const s = inline(n).trim(); out += s ? '~~' + s + '~~' : ''; continue; }
      if (tag === 'a') {
        const href = n.getAttribute('href') || '';
        const txt = inline(n).trim() || href;
        out += href && !href.startsWith('#') ? '[' + txt + '](' + href + ')' : txt;
        continue;
      }
      out += inline(n);
    }
    return out;
  }

  function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function renderTable(el) {
    const table = el.tagName === 'TABLE' ? el : el.querySelector('table');
    if (!table) return '';
    const rows = [...table.querySelectorAll('tr')];
    if (!rows.length) return '';
    const clean = (s) => s.replace(/[\\u200B-\\u200F\\uFEFF]/g, '').replace(/\\s*\\n\\s*/g, ' ').trim();
    // 依 rowspan/colspan 展开：真合并用 rowspan/colspan 原样输出
    const occ = {};
    const cells = [];
    let maxC = 0;
    rows.forEach((tr, r) => {
      let c = 0;
      for (const td of tr.children) {
        const text = clean(inline(td));
        const naturalCovered = occ[r] && occ[r][c];
        // rowspan 覆盖位的空占位 td：跳过，不占后面的自由槽位
        if (!text && naturalCovered) { c++; continue; }
        while (occ[r] && occ[r][c]) c++;
        const rs = Math.max(1, parseInt(td.getAttribute('rowspan') || '1', 10) || 1);
        const cs = Math.max(1, parseInt(td.getAttribute('colspan') || '1', 10) || 1);
        cells.push({ r, c, rs, cs, text });
        for (let dr = 0; dr < rs; dr++) {
          occ[r + dr] = occ[r + dr] || [];
          for (let dc = 0; dc < cs; dc++) occ[r + dr][c + dc] = true;
        }
        c += cs;
        maxC = Math.max(maxC, c);
      }
    });
    const out = ['<table>'];
    for (let r = 0; r < rows.length; r++) {
      out.push('<tr>');
      for (let c = 0; c < maxC; c++) {
        const cell = cells.find((x) => x.r === r && x.c === c);
        if (cell) {
          const span = (cell.rs > 1 ? ' rowspan="' + cell.rs + '"' : '') + (cell.cs > 1 ? ' colspan="' + cell.cs + '"' : '');
          out.push('<td' + span + '>' + escHtml(cell.text).replace(/\\n/g, '<br>') + '</td>');
        } else if (!occ[r] || !occ[r][c]) {
          out.push('<td></td>');
        }
      }
      out.push('</tr>');
    }
    out.push('</table>');
    return out.join('\\n');
  }

  function renderBlock(el, depth) {
    if (!el || el.nodeType !== 1) return '';
    const { t, n } = classify(el);
    const pad = '  '.repeat(Math.max(0, depth));
    const text = () => inline(el).replace(/\\n{3,}/g, '\\n\\n').trim();

    switch (t) {
      case 'header': return pad + '#'.repeat(n || 1) + ' ' + text();
      case 'bullet': {
        const kids = childBlocks(el).map((b) => renderBlock(b, depth + 1)).filter(Boolean);
        const self = inline([...el.childNodes].filter((c) => !(c.nodeType === 1 && (c.hasAttribute('data-block-id') || c.querySelector(':scope [data-block-id]'))))).trim();
        return (pad + '- ' + self + (self && kids ? '\\n' : '') + kids.join('\\n'));
      }
      case 'ordered': {
        const kids = childBlocks(el);
        if (kids.length) return kids.map((b, i) => renderBlock(b, depth).replace(/^(\\s*)- /, '$1' + (i + 1) + '. ')).join('\\n');
        return pad + '1. ' + text();
      }
      case 'todo': {
        const checked = !!el.querySelector('input:checked, [class*="checked"]');
        return pad + '- [' + (checked ? 'x' : ' ') + '] ' + text();
      }
      case 'quote': {
        const kids = childBlocks(el);
        const body = kids.length ? kids.map((b) => renderBlock(b, 0)).join('\\n') : text();
        return body.split('\\n').map((l) => pad + '> ' + l).join('\\n');
      }
      case 'callout': {
        const kids = childBlocks(el);
        const body = kids.length ? kids.map((b) => renderBlock(b, 0)).join('\\n') : text();
        return pad + '> [!NOTE]\\n' + body.split('\\n').map((l) => pad + '> ' + l).join('\\n');
      }
      case 'code': {
        const pre = el.querySelector('pre') || el;
        const codeEl = el.querySelector('code') || pre;
        const langM = (el.className + ' ' + codeEl.className).match(/language-([\\w-]+)/);
        return pad + '\\u0060\\u0060\\u0060' + (langM ? langM[1] : '') + '\\n' + (codeEl.innerText || pre.innerText || '').replace(/\\n$/, '') + '\\n' + pad + '\\u0060\\u0060\\u0060';
      }
      case 'table': return renderTable(el);
      case 'image': {
        const imgs = [...el.querySelectorAll('img')].map((i) => i.getAttribute('src')).filter((s) => s && !s.startsWith('data:'));
        return imgs.map((s) => pad + '![](' + s + ')').join('\\n');
      }
      case 'divider': return pad + '---';
      case 'container': {
        const kids = childBlocks(el).map((b) => renderBlock(b, depth)).filter(Boolean);
        return kids.join('\\n\\n');
      }
      default: {
        const kids = childBlocks(el);
        if (kids.length) return kids.map((b) => renderBlock(b, depth)).filter(Boolean).join('\\n\\n');
        return pad + text();
      }
    }
  }

  // ---------- 主流程 ----------
  const root = pickRoot();
  await new Promise((r) => setTimeout(r, 500));

  if (mode === 'html') {
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script,style,noscript').forEach((e) => e.remove());
    const html = clone.innerHTML;
    const images = [...new Set([...root.querySelectorAll('img')].map((i) => i.getAttribute('src')).filter((s) => s && !s.startsWith('data:')))];
    return { mode, html, images, title: document.title };
  }

  const topBlocks = childBlocks(root);
  const parts = topBlocks
    .map((b, i) => ({ id: b.getAttribute('data-block-id') || 'idx' + i, md: renderBlock(b, 0) }))
    .filter((p) => p.md && p.md.trim());
  const markdown = parts.map((p) => p.md).join('\\n\\n');
  const images = [...new Set([...root.querySelectorAll('img')].map((i) => i.getAttribute('src')).filter((s) => s && !s.startsWith('data:')))];
  return {
    mode,
    markdown,
    blocks: parts,
    images,
    title: document.title,
    blockCount: topBlocks.length,
    unknowns: [...unknownTypes.entries()],
  };
}
`;
