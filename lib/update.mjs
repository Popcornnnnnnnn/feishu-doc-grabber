import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from './cli-options.mjs';
import { statePath } from './workspace-state.mjs';

export const REPO = 'Popcornnnnnnnn/feishu-doc-grabber';
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
export const CHECK_INTERVAL_MS = 86_400_000;
export const ENV_DISABLE = 'FEISHU_GRAB_NO_UPDATE_CHECK';

const SKIP_COMMANDS = new Set(['upgrade', 'completion', 'version', 'help']);
const SKIP_FLAGS = new Set(['--json', '--help', '-h', '--version', '-v', '-V']);

export function updateCachePath(stateFile = statePath()) {
  return join(dirname(stateFile), '.feishu-grab-update.json');
}

export function normalizeVersion(version) {
  return String(version ?? '').trim().replace(/^v/i, '');
}

function parseVersion(version) {
  const match = /^v?(\d+(?:\.\d+)*)(?:[-.]([0-9a-z.-]+))?$/i.exec(String(version ?? '').trim());
  if (!match) return null;
  const core = match[1].split('.').map((part) => Number.parseInt(part, 10));
  const pre = match[2] ?? '';
  return { core, isFinal: pre === '', pre: pre.toLowerCase() };
}

export function isNewerVersion(remote, current) {
  const r = parseVersion(remote);
  const c = parseVersion(current);
  if (!r || !c) return false;
  const width = Math.max(r.core.length, c.core.length);
  for (let i = 0; i < width; i++) {
    const rv = r.core[i] ?? 0;
    const cv = c.core[i] ?? 0;
    if (rv !== cv) return rv > cv;
  }
  if (r.isFinal !== c.isFinal) return r.isFinal;
  if (!r.isFinal && r.pre !== c.pre) return r.pre > c.pre;
  return false;
}

function isTruthy(value) {
  return Boolean(value && ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase()));
}

export function shouldCheckUpdates({
  command,
  argv = [],
  env = process.env,
  stderrIsTTY = Boolean(process.stderr?.isTTY),
} = {}) {
  if (isTruthy(env?.[ENV_DISABLE])) return false;
  if (env?.CI) return false;
  if (!stderrIsTTY) return false;
  if (SKIP_COMMANDS.has(command)) return false;
  if (argv.some((arg) => SKIP_FLAGS.has(arg))) return false;
  return true;
}

export function readUpdateCache(cacheFile) {
  try {
    const raw = readFileSync(cacheFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeUpdateCache(cacheFile, payload) {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(payload, null, 2));
  } catch {
    // Cache writes must never block or fail CLI execution.
  }
}

export async function fetchLatestRelease({ timeoutMs = 10_000, fetchImpl = fetch, currentVersion = '0.0.0' } = {}) {
  const response = await fetchImpl(LATEST_RELEASE_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `feishu-grab/${normalizeVersion(currentVersion)}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`GitHub Releases returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.draft || payload.prerelease) {
    throw new Error('Latest release is a draft or prerelease.');
  }
  const tagName = String(payload.tag_name ?? '').trim();
  if (!tagName) {
    throw new Error('GitHub Releases payload missing tag_name.');
  }
  return {
    tagName,
    version: normalizeVersion(tagName),
    releaseUrl: String(payload.html_url ?? `https://github.com/${REPO}/releases/latest`),
  };
}

export async function refreshUpdateCache(cacheFile, options = {}) {
  const release = await fetchLatestRelease({
    timeoutMs: options.timeoutMs ?? 5_000,
    fetchImpl: options.fetchImpl,
    currentVersion: options.currentVersion,
  });
  const payload = {
    checkedAt: options.now ?? Date.now(),
    latestVersion: release.version,
    tagName: release.tagName,
    releaseUrl: release.releaseUrl,
  };
  writeUpdateCache(cacheFile, payload);
  return payload;
}

function defaultSpawnRefresh(cacheFile) {
  if (process.env.NODE_TEST_CONTEXT) return;
  try {
    const scriptPath = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [scriptPath, '--refresh-cache', cacheFile], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // Ignore spawn failures.
  }
}

export function maybeNotifyUpdate({
  currentVersion,
  command,
  argv = [],
  stateFile = statePath(),
  cacheFile = updateCachePath(stateFile),
  env = process.env,
  stderr = process.stderr,
  stderrIsTTY = Boolean(stderr?.isTTY),
  now = Date.now(),
  spawnRefresh = defaultSpawnRefresh,
} = {}) {
  if (!shouldCheckUpdates({ command, argv, env, stderrIsTTY })) return null;
  const cached = readUpdateCache(cacheFile);
  let stale = true;
  let notice = null;

  if (cached) {
    if (typeof cached.checkedAt === 'number' && (now - cached.checkedAt) < CHECK_INTERVAL_MS) {
      stale = false;
    }
    const latest = String(cached.latestVersion ?? '').trim();
    if (latest && isNewerVersion(latest, currentVersion)) {
      notice = `\nUpdate available: feishu-grab v${latest} (current v${normalizeVersion(currentVersion)}). Run: feishu-grab upgrade\n`;
      try {
        stderr?.write(notice);
      } catch {
        // Ignore stderr write errors.
      }
    }
  }

  if (stale) {
    spawnRefresh(cacheFile);
  }
  return notice;
}

export function detectInstallMethod(moduleUrl = import.meta.url) {
  const target = moduleUrl.startsWith('file://') ? fileURLToPath(moduleUrl) : String(moduleUrl);
  if (target.includes('/Cellar/feishu-grab/') || target.includes('/opt/homebrew/') || target.includes('/usr/local/Cellar/')) {
    return 'homebrew';
  }
  return 'source';
}

function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  return result.status ?? 1;
}

export async function runUpgradeCommand(
  rest,
  {
    currentVersion,
    stdout = process.stdout,
    stderr = process.stderr,
    stateFile = statePath(),
    cacheFile = updateCachePath(stateFile),
    fetchImpl = fetch,
    runCommand = defaultRunCommand,
    moduleUrl = import.meta.url,
  } = {},
) {
  let checkOnly = false;
  let json = false;
  for (const arg of rest) {
    if (arg === '--check') checkOnly = true;
    else if (arg === '--json') json = true;
    else throw new UsageError(`Unknown option for upgrade: ${arg}`);
  }

  let release;
  try {
    release = await refreshUpdateCache(cacheFile, {
      timeoutMs: 10_000,
      fetchImpl,
      currentVersion,
    });
  } catch (error) {
    if (json) {
      stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    } else {
      stderr.write(`Could not check for updates: ${error.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const current = normalizeVersion(currentVersion);
  const latest = release.latestVersion;
  const available = isNewerVersion(latest, current);
  const installMethod = detectInstallMethod(moduleUrl);
  const upgradeCommand = installMethod === 'homebrew'
    ? 'brew update && brew upgrade Popcornnnnnnnn/tap/feishu-grab'
    : 'git pull && npm install && npm link';

  if (json) {
    stdout.write(`${JSON.stringify({
      current,
      latest,
      updateAvailable: available,
      installMethod,
      releaseUrl: release.releaseUrl,
      upgradeCommand,
    })}\n`);
    return;
  }

  if (!available) {
    stdout.write(`feishu-grab ${current} is already up to date.\n`);
    return;
  }

  if (checkOnly) {
    stdout.write(
      `Update available: feishu-grab v${latest} (current v${current}).\n`
      + `Install method: ${installMethod}\n`
      + `Upgrade with: ${upgradeCommand}\n`
      + `Release: ${release.releaseUrl}\n`,
    );
    return;
  }

  if (installMethod === 'homebrew') {
    stdout.write(`Upgrading feishu-grab to v${latest} via Homebrew...\n`);
    for (const [cmd, args] of [['brew', ['update']], ['brew', ['upgrade', 'Popcornnnnnnnn/tap/feishu-grab']]]) {
      const code = runCommand(cmd, args);
      if (code !== 0) {
        stderr.write(`Command failed (${code}): ${cmd} ${args.join(' ')}\n`);
        process.exitCode = code;
        return;
      }
    }
    return;
  }

  stdout.write(
    `Update available: feishu-grab v${latest} (current v${current}).\n`
    + `Installed from source. Update with:\n  ${upgradeCommand}\n`
    + `Or download from: ${release.releaseUrl}\n`,
  );
}

function isDirectEntry() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  const index = process.argv.indexOf('--refresh-cache');
  const targetCache = index >= 0 ? process.argv[index + 1] : null;
  if (targetCache) {
    refreshUpdateCache(targetCache, { timeoutMs: 5_000 }).catch(() => {});
  }
}
