import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const APP = 'com.google.Chrome';
const MAX_BYTES = 100 * 1024 * 1024;
const CHUNK = 192 * 1024;
const READ_API = /^\/space\/api\/(?:wiki\/v2\/tree\/get_node\/?|docx\/pages\/client_vars|comment\/(?:commentid\/all|batch)|v3\/sheet\/(?:resource\/?|client_vars|formula\/data_block))$/;
const POST_API = /^\/space\/api\/(?:comment\/(?:commentid\/all|batch)|v3\/sheet\/(?:resource\/?|client_vars))$/;

export function documentURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !/(^|\.)(feishu\.cn|larkoffice\.com|larksuite\.com)$/.test(url.hostname)
      || !/^\/(docx|wiki|docs)\/[A-Za-z0-9]+\/?$/.test(url.pathname)) {
    throw new Error('Use an HTTPS Feishu/Lark docx, wiki, or docs link.');
  }
  url.hash = '';
  return url;
}

export function allowedRequest(source, value, method = 'GET') {
  const origin = documentURL(source);
  const target = new URL(value);
  if (target.protocol !== 'https:' || target.username || target.password || target.port || !['GET', 'POST'].includes(method)) return false;
  if (target.origin === origin.origin) {
    if (method === 'POST') return POST_API.test(target.pathname);
    return READ_API.test(target.pathname) || /^\/(docx|wiki|docs)\/[A-Za-z0-9]+\/?$/.test(target.pathname);
  }
  const streamHost = origin.hostname.endsWith('feishu.cn')
    ? 'internal-api-drive-stream.feishu.cn' : 'internal-api-drive-stream.larksuite.com';
  return method === 'GET' && target.hostname === streamHost
    && /^\/space\/api\/box\/stream\/download\/(?:all|preview|v2\/cover)\/[A-Za-z0-9]+\/?$/.test(target.pathname);
}

export function appleString(value) {
  return '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    .replaceAll('\r', '\\r').replaceAll('\n', '\\n') + '"';
}

function explainError(message) {
  if (/JavaScript.*Apple|Apple.*JavaScript|javascript.*(?:disabled|turned off)/i.test(message)) {
    return 'In Chrome, enable View > Developer > Allow JavaScript from Apple Events, then rerun feishu-grab --doctor.';
  }
  if (/not authorized|not allowed|1743/i.test(message)) {
    return 'macOS blocked Chrome automation. Allow your terminal to control Google Chrome in System Settings > Privacy & Security > Automation, then rerun feishu-grab --doctor.';
  }
  return message.trim();
}

export function runAppleScript(script, { timeoutMs = 15000 } = {}) {
  if (process.platform !== 'darwin') return Promise.reject(new Error('Daily Chrome session reuse currently requires macOS.'));
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], errors = [];
    let size = 0, expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', (data) => {
      size += data.length;
      if (size > 2 * 1024 * 1024) child.kill();
      else output.push(data);
    });
    child.stderr.on('data', (data) => errors.push(data));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (expired) reject(new Error('Chrome did not respond to AppleScript in time. Check for a macOS automation permission prompt.'));
      else if (code !== 0) reject(new Error(explainError(Buffer.concat(errors).toString()) || 'Chrome automation failed.'));
      else resolve(Buffer.concat(output).toString().trimEnd());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}

// Only tab IDs and URLs are read. No profile files, cookies, or storage are inspected.
const INVENTORY = `if application id "${APP}" is not running then error "Open your daily Google Chrome and sign in to Feishu first."
tell application id "${APP}"
  set rows to ""
  repeat with w in windows
    repeat with t in tabs of w
      set rows to rows & (id of w as text) & tab & (id of t as text) & tab & (URL of t) & linefeed
    end repeat
  end repeat
  return rows
end tell`;

// Runs in the document page. Browser authentication stays inside Chrome.
// It exposes only response bodies and non-sensitive response metadata.
export function startPageRequest(key, url, options, limit, timeoutMs) {
  const controller = new AbortController();
  const job = { done: false, controller };
  Object.defineProperty(globalThis, key, { value: job, configurable: true });
  (async () => {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, credentials: 'include', signal: controller.signal });
      job.status = response.status;
      job.url = response.url;
      job.contentType = response.headers.get('content-type') || '';
      const declared = Number(response.headers.get('content-length'));
      if (declared > limit) throw new Error('Resource exceeds the 100 MB export limit.');
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader) {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > limit) throw new Error('Resource exceeds the 100 MB export limit.');
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
      }
      job.bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { job.bytes.set(chunk, offset); offset += chunk.length; }
      job.size = size;
    } catch (error) {
      job.error = error.name === 'AbortError' ? 'Document request timed out.' : error.message;
    } finally { clearTimeout(timer); job.done = true; }
  })();
  return 'started';
}

export class DailyChrome {
  constructor({ timeoutMs = 180000, run = runAppleScript } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Timeout must be a positive number.');
    this.timeoutMs = timeoutMs;
    this.run = run;
    this.created = new Map();
  }

  async tabs() {
    return (await this.run(INVENTORY)).split('\n').filter(Boolean).map((row) => {
      const [windowId, id, url] = row.split('\t');
      if (!/^\d+$/.test(windowId) || !/^\d+$/.test(id)) throw new Error('Chrome returned an invalid tab identifier.');
      return { windowId: Number(windowId), id: Number(id), url };
    });
  }

  async currentURL() {
    const url = await this.run(`if application id "${APP}" is not running then error "Open Google Chrome first."
    tell application id "${APP}"
      if (count of windows) is 0 then error "Open a Feishu document in Google Chrome first."
      return URL of active tab of front window
    end tell`);
    return documentURL(url).href;
  }

  async execute(target, javascript) {
    const guarded = `(() => { if (location.href !== ${JSON.stringify(target.url)}) throw new Error('The source tab changed. Rerun the export from the intended document.'); return (${javascript}); })()`;
    return this.run(`tell application id "${APP}"
      repeat with w in windows
        repeat with t in tabs of w
          if id of t is ${target.id} then return execute t javascript ${appleString(guarded)}
        end repeat
      end repeat
      error "The source Chrome tab was closed."
    end tell`);
  }

  async doctor({ quiet = false } = {}) {
    const tabs = await this.tabs();
    const target = tabs.find((tab) => { try { documentURL(tab.url); return true; } catch { return false; } });
    if (!target) throw new Error('Open a signed-in Feishu/Lark document in your daily Chrome, then rerun feishu-grab --doctor.');
    const result = await this.execute(target, 'JSON.stringify({ ready: document.readyState !== "loading" })');
    if (!JSON.parse(result).ready) throw new Error('Wait for the Feishu document to load, then rerun feishu-grab --doctor.');
    if (!quiet) {
      console.log('✓ Daily Chrome is connected. No extension or separate browser login is needed.');
      console.log('Document access and server authentication are checked during export.');
    }
    return { browser: 'chrome', connected: true, authentication: 'checked-during-export' };
  }

  async prepare(value) {
    const source = documentURL(value);
    this.source = source.href;
    const tabs = await this.tabs();
    this.target = tabs.find((tab) => {
      try { const existing = documentURL(tab.url); return existing.origin === source.origin && existing.pathname === source.pathname; }
      catch { return false; }
    });
    if (!this.target) {
      const sameSite = tabs.find((tab) => { try { return new URL(tab.url).origin === source.origin; } catch { return false; } });
      const id = await this.run(`tell application id "${APP}"
        ${sameSite ? `set w to first window whose id is ${sameSite.windowId}` : 'if (count of windows) is 0 then error "Open your daily Chrome window first."\nset w to front window'}
        set t to make new tab at end of tabs of w with properties {URL:${appleString(source.href)}}
        return id of t
      end tell`);
      if (!/^\d+$/.test(id)) throw new Error('Could not create a Chrome document tab.');
      this.created.set(Number(id), source.href);
      const deadline = Date.now() + Math.min(this.timeoutMs, 60000);
      while (Date.now() < deadline) {
        this.target = (await this.tabs()).find((tab) => tab.id === Number(id));
        if (!this.target) throw new Error('The new document tab was closed.');
        try {
          const loaded = documentURL(this.target.url);
          if (loaded.origin !== source.origin) throw new Error('Sign in to the document site in your daily Chrome, then retry.');
          if (await this.execute(this.target, 'document.readyState !== "loading"') === 'true') {
            this.created.set(Number(id), this.target.url);
            break;
          }
        } catch (error) {
          if (this.target.url !== 'about:blank') throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!this.target || await this.execute(this.target, 'document.readyState !== "loading"') !== 'true') throw new Error('The document did not finish loading in Chrome.');
    }
    await this.execute(this.target, '"connected"');
  }

  async request(value, options = {}) {
    const method = options.method || 'GET';
    if (!this.target || !allowedRequest(this.source, value, method)) throw new Error('Unsupported document read request.');
    // Older exporter versions request /all/. The preview route with type 16
    // serves the original payload and is also used by the current exporter.
    const resource = new URL(value);
    if (resource.pathname.startsWith('/space/api/box/stream/download/all/')) {
      resource.pathname = resource.pathname.replace('/download/all/', '/download/preview/');
      resource.searchParams.set('preview_type', '16');
      value = resource.href;
    }
    // Do not copy authentication headers. Chrome's normal fetch credentials apply.
    const headers = {};
    for (const [name, value] of Object.entries(options.headers || {})) {
      if (['accept', 'accept-language', 'content-type'].includes(name.toLowerCase())) headers[name] = value;
    }
    const key = '__feishuCLI_' + randomUUID().replaceAll('-', '');
    const setup = `(${startPageRequest.toString()})(${JSON.stringify(key)},${JSON.stringify(value)},${JSON.stringify({ method, headers, body: options.body })},${MAX_BYTES},${Math.min(this.timeoutMs, 60000)})`;
    try {
      await this.execute(this.target, setup);
      const deadline = Date.now() + Math.min(this.timeoutMs, 60000) + 3000;
      let metadata;
      while (Date.now() < deadline) {
        metadata = JSON.parse(await this.execute(this.target, `JSON.stringify((() => { const j = globalThis[${JSON.stringify(key)}]; if (!j) throw new Error('The source page reloaded.'); return { done: j.done, error: j.error, status: j.status, url: j.url, size: j.size, contentType: j.contentType }; })())`));
        if (metadata.done) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (!metadata?.done) throw new Error('Document request timed out.');
      if (metadata.error) throw new Error(`${metadata.error} (Chrome may block cross-origin resources or the session may have expired).`);
      if (!allowedRequest(this.source, metadata.url, 'GET')) throw new Error('Chrome was redirected away from the document. Sign in to Feishu in your daily Chrome and retry.');
      if (!Number.isInteger(metadata.size) || metadata.size < 0 || metadata.size > MAX_BYTES) throw new Error('Invalid Chrome response size.');
      const chunks = [];
      for (let offset = 0; offset < metadata.size; offset += CHUNK) {
        const encoded = await this.execute(this.target, `(() => { const bytes = globalThis[${JSON.stringify(key)}].bytes.subarray(${offset},${offset + CHUNK}); let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); })()`);
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length !== Math.min(CHUNK, metadata.size - offset)) throw new Error('Chrome returned an incomplete response chunk.');
        chunks.push(bytes);
      }
      const response = new Response([204, 205, 304].includes(metadata.status) ? null : Buffer.concat(chunks), { status: metadata.status, headers: { 'content-type': metadata.contentType } });
      Object.defineProperty(response, 'url', { value: metadata.url });
      if ([401, 403].includes(response.status)) throw new Error(`Document access failed (HTTP ${response.status}). Check sign-in and document permissions in daily Chrome.`);
      return response;
    } finally {
      await this.execute(this.target, `(() => { const j = globalThis[${JSON.stringify(key)}]; j?.controller.abort(); delete globalThis[${JSON.stringify(key)}]; return 'cleaned'; })()`).catch(() => {});
    }
  }

  async disconnect() {
    const tabs = await this.tabs().catch(() => []);
    for (const [id, expectedURL] of this.created) {
      const target = tabs.find((tab) => tab.id === id);
      // Preserve a temporary tab if the user navigated it to unrelated work.
      if (!target || target.url !== expectedURL) continue;
      try { documentURL(target.url); } catch { continue; }
      await this.run(`tell application id "${APP}"
        repeat with w in windows
          repeat with t in tabs of w
            if id of t is ${id} and URL of t is ${appleString(target.url)} then
              close t
              return
            end if
          end repeat
        end repeat
      end tell`).catch(() => {});
    }
    this.created.clear();
  }
}
