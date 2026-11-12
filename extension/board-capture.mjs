// Whiteboard visual fallback: locate the board block in the source tab and
// capture it as a PNG. The board canvas paints on demand for whatever is
// visible, so the capture expands the viewport first (Emulation override),
// waits for the canvas to repaint and stabilize, then takes a plain clipped
// screenshot — never captureBeyondViewport, which re-lays-out the page mid
// capture. If the debugger is unavailable, fall back to cropping a
// visible-tab screenshot. Every failure throws a message that ends up in the
// export report; nothing is silently dropped.

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const toBase64 = (bytes) => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};
const fromBase64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

// Runs in the source tab's isolated world via chrome.scripting. Scrolls
// virtualized document containers until the board block mounts. Injected
// functions must be self-contained: executeScript serializes only this
// function's source, not any module-scope helpers it references.
export async function locateBoardBlock(blockId, index, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const find = () => {
    const byId = document.querySelector(`[data-block-id="${blockId}"], [data-record-id="${blockId}"]`);
    if (byId) return byId;
    const candidates = document.querySelectorAll('.docx-whiteboard-block, [data-block-type="whiteboard"], [data-block-type="board"]');
    return candidates.length === 1 ? candidates[0] : candidates[index] || null;
  };
  const scrollThrough = async () => {
    const containers = [...document.querySelectorAll('*')].filter((element) => {
      const style = getComputedStyle(element);
      return element.scrollHeight - element.clientHeight > 100 && element.clientHeight > 150
        && (style.overflowY === 'auto' || style.overflowY === 'scroll');
    }).sort((a, b) => b.scrollHeight - a.scrollHeight).slice(0, 6);
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      for (const container of containers) {
        container.scrollTop = (container.scrollHeight - container.clientHeight) * ratio;
        container.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
      await sleep(800);
      const element = find();
      if (element) return element;
    }
    return find();
  };
  const element = await scrollThrough();
  if (!element) throw new Error('the board block is not present in the page. Scroll the document to it and try again.');
  const rect = element.getBoundingClientRect();
  return {
    pageX: rect.x + window.scrollX, pageY: rect.y + window.scrollY,
    width: rect.width, height: rect.height,
    innerWidth: window.innerWidth, dpr: window.devicePixelRatio || 1,
    scrollX: window.scrollX, scrollY: window.scrollY,
  };
}

// Runs after the viewport has been expanded: scrolls the board into view and
// samples its canvas until a repaint produces two identical frames.
export async function stabilizeBoard(blockId, index, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const find = () => {
    const byId = document.querySelector(`[data-block-id="${blockId}"], [data-record-id="${blockId}"]`);
    if (byId) return byId;
    const candidates = document.querySelectorAll('.docx-whiteboard-block, [data-block-type="whiteboard"], [data-block-type="board"]');
    return candidates.length === 1 ? candidates[0] : candidates[index] || null;
  };
  const element = find();
  if (!element) throw new Error('the board block disappeared while preparing the capture.');
  const sample = () => {
    const rect = element.getBoundingClientRect();
    let paint = '';
    const canvas = element.querySelector('canvas');
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      try {
        const thumb = document.createElement('canvas');
        const ratio = Math.min(1, 96 / Math.max(canvas.width, canvas.height));
        thumb.width = Math.max(1, Math.round(canvas.width * ratio));
        thumb.height = Math.max(1, Math.round(canvas.height * ratio));
        const context = thumb.getContext('2d');
        context.drawImage(canvas, 0, 0, thumb.width, thumb.height);
        const data = context.getImageData(0, 0, thumb.width, thumb.height).data;
        let checksum = 0;
        for (let offset = 0; offset < data.length; offset += 37) checksum = (checksum * 31 + data[offset]) | 0;
        paint = `${thumb.width}x${thumb.height}:${checksum}`;
      } catch { paint = 'opaque'; }
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, paint, scrollY: window.scrollY };
  };
  element.scrollIntoView({ block: 'start' });
  let previous = '';
  while (Date.now() < deadline) {
    await sleep(900);
    const current = sample();
    const key = JSON.stringify(current);
    // Fully inside the (expanded) viewport, with room for fixed toolbars.
    const visible = current.y >= -4 && current.y + current.height <= window.innerHeight + 4;
    if (key === previous && visible && current.width > 20 && current.height > 20) return current;
    previous = key;
  }
  throw new Error('the board canvas did not stabilize after the viewport change.');
}

async function imageStats(bytes) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const counts = new Map();
    let total = 0;
    for (let offset = 0; offset < data.length; offset += 16) {
      if (data[offset + 3] === 0) { counts.set('transparent', (counts.get('transparent') || 0) + 1); }
      else {
        const key = `${data[offset] >> 4},${data[offset + 1] >> 4},${data[offset + 2] >> 4}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      total++;
    }
    const dominant = Math.max(...counts.values());
    return { width: bitmap.width, height: bitmap.height, flat: total > 0 && dominant / total > 0.995 };
  } finally { bitmap.close(); }
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function visibleTabCapture(tabId, rect) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    throw new Error('this Chrome build cannot crop visible-tab screenshots.');
  }
  if (rect.vx < 0 || rect.vy < 0 || rect.vx + rect.width > rect.innerWidth + 1 || rect.vy + rect.height > rect.innerHeight + 1) {
    throw new Error('the board extends beyond the visible page area and the debugger capture route is unavailable.');
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tabId, { format: 'png' });
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const scale = bitmap.width / rect.innerWidth;
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(rect.width * scale)), Math.max(1, Math.round(rect.height * scale)));
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, rect.vx * scale, rect.vy * scale, rect.width * scale, rect.height * scale, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), route: 'visible-tab', width: canvas.width, height: canvas.height };
  } finally { bitmap.close(); }
}

async function captureWithDebugger(tabId, rect, signal) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  let overrideApplied = false;
  try {
    // Grow the viewport to cover the whole board so its canvas repaints with
    // the full content; capture happens only after the repaint settles.
    const dpr = Math.max(1, rect.dpr || 1);
    const viewHeight = Math.min(Math.max(Math.ceil(rect.height) + 160, 400), Math.floor(16000 / dpr));
    await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
      width: Math.round(rect.innerWidth), height: viewHeight,
      deviceScaleFactor: dpr, mobile: false,
    });
    overrideApplied = true;
    const stable = await chrome.scripting.executeScript({
      target: { tabId }, func: stabilizeBoard, args: [rect.blockId, rect.index, 15000],
    }).then(([execution]) => {
      if (!execution?.result) throw new Error('could not inspect the source tab.');
      return execution.result;
    });
    signal?.throwIfAborted();
    const scale = Math.max(0.1, Math.min(dpr, 2, 8000 / Math.max(stable.width, stable.height, 1)));
    const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      clip: { x: stable.x, y: stable.y, width: Math.max(1, stable.width), height: Math.max(1, stable.height), scale },
    });
    if (!shot?.data) throw new Error('the debugger returned no image.');
    return {
      bytes: fromBase64(shot.data), route: 'debugger',
      width: Math.round(stable.width * scale), height: Math.round(stable.height * scale),
    };
  } finally {
    if (overrideApplied) await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    chrome.debugger.detach(target).catch(() => {});
  }
}

const scrollTo = (tabId, x, y) => chrome.scripting.executeScript({
  target: { tabId }, func: (sx, sy) => window.scrollTo(sx, sy), args: [x, y],
}).catch(() => {});

// Retries until the deadline: locate can fail while the document is still
// loading, and a flat capture means the board had not painted yet.
export async function captureBoard({ tabId, blockId, index = 0, signal, timeoutMs = 60000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    signal?.throwIfAborted();
    try {
      const rect = await chrome.scripting.executeScript({
        target: { tabId }, func: locateBoardBlock, args: [blockId, index, 20000],
      }).then(([execution]) => {
        if (!execution?.result) throw new Error('could not inspect the source tab.');
        return execution.result;
      });
      const restore = { x: rect.scrollX, y: rect.scrollY };
      let shot;
      try {
        shot = await captureWithDebugger(tabId, { ...rect, blockId, index }, signal);
      } catch (debuggerError) {
        if (signal?.aborted) throw debuggerError;
        const stable = await chrome.scripting.executeScript({
          target: { tabId }, func: stabilizeBoard, args: [blockId, index, 10000],
        }).then(([execution]) => execution?.result);
        if (!stable) throw debuggerError;
        shot = await visibleTabCapture(tabId, {
          ...stable, innerWidth: rect.innerWidth,
        });
      }
      await scrollTo(tabId, restore.x, restore.y);
      const stats = await imageStats(shot.bytes);
      if (stats?.flat) throw new Error('the captured image appears blank; the board had not painted yet.');
      return {
        data: toBase64(shot.bytes), width: stats?.width || shot.width, height: stats?.height || shot.height,
        route: shot.route, sha256: await sha256(shot.bytes),
      };
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;
      await sleep(Math.min(1200 * attempt, 4000));
    }
  }
  signal?.throwIfAborted();
  throw new Error(lastError?.message ? `board capture failed: ${lastError.message}` : 'board capture timed out.');
}
