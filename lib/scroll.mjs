/**
 * 自动滚动 + 懒加载等待策略。
 *
 * 思路（对应 PLAN Phase A）：
 * 1. 找到页面里真正承载文档的虚拟滚动容器（overflow-y: auto/scroll 且可滚动的元素）
 * 2. 逐段把每个容器滚到底，触发懒加载
 * 3. 以「页面总高度 / 容器滚动高度连续 N 轮不变」作为加载完成依据
 * 4. 最后等待所有 <img> 加载完成，避免打印出空图
 */

const IN_PAGE_FN = `
async ({ step = 800, maxMs = 180000, stableRounds = 4, roundGapMs = 400 } = {}) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const started = Date.now();

  // 收集候选滚动容器：可滚动区域足够大才算
  const getContainers = () => {
    const found = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight - el.clientHeight < 100) continue;
      if (el.clientHeight < 150) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') found.push(el);
    }
    // 大的优先（文档主容器），最多处理 6 个
    found.sort((a, b) => b.scrollHeight - a.scrollHeight);
    return found.slice(0, 6);
  };

  const snapshot = () => {
    const cs = getContainers();
    return {
      docH: document.documentElement.scrollHeight,
      boxes: cs.map((c) => c.scrollHeight + ':' + c.clientHeight + ':' + c.scrollTop).join('|'),
      done: cs.every((c) => c.scrollTop + c.clientHeight >= c.scrollHeight - 4),
    };
  };

  const kick = () => {
    // 兜底：往主滚动容器和 window 都发一轮 wheel 事件，
    // 有些编辑器（虚拟滚动）只认 wheel 不认 scrollTop 赋值
    const cs = getContainers();
    const target = cs[0] || document.scrollingElement || document.body;
    const r = target.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (const dy of [-step, -step, -step]) {
      target.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY: dy, clientX: cx, clientY: cy,
      }));
      window.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY: dy, clientX: cx, clientY: cy,
      }));
    }
  };

  // 主循环：滚动 → 记录高度 → 稳定判定
  let stable = 0;
  let last = '';
  let lastHeights = '';
  while (Date.now() - started < maxMs) {
    const cs = getContainers();

    // 1) 把每个容器往下滚一段
    for (const c of cs) {
      if (c.scrollTop + c.clientHeight < c.scrollHeight - 4) {
        c.scrollTop = c.scrollTop + step * 2;
        c.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    kick();

    await sleep(roundGapMs);

    // 2) 高度快照，判断是否稳定
    const snap = snapshot();
    const heights = snap.docH + '#' + snap.boxes;
    if (heights === lastHeights) {
      stable++;
    } else {
      stable = 0;
      lastHeights = heights;
    }

    // 全部到底 + 高度连续 stableRounds 轮不变 → 完成
    if (snap.done && stable >= stableRounds) break;
    if (stable >= stableRounds + 8) break; // 高度稳定但没到底，也认为加载完了
  }

  // 3) 等 img：懒加载图可能还在路上
  const imgDeadline = Date.now() + 15000;
  let pending = -1;
  while (Date.now() < imgDeadline) {
    pending = [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).length;
    if (pending === 0) break;
    await sleep(500);
  }

  // 滚回顶部再交付打印（保证 PDF 从头开始、目录锚点正确）
  for (const c of getContainers()) c.scrollTop = 0;
  window.scrollTo(0, 0);
  await sleep(300);

  return { ok: true, elapsedMs: Date.now() - started, pendingImages: Math.max(pending, 0) };
}
`;

/**
 * @param {import('puppeteer-core').Page} page
 * @param {object} [opts]
 */
export async function autoScroll(page, opts = {}) {
  // 先给编辑器一点首屏渲染时间
  await new Promise((r) => setTimeout(r, 1500));
  return page.evaluate(`(${IN_PAGE_FN.trim()})(${JSON.stringify(opts)})`);
}
