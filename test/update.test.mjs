import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runCLI } from '../lib/cli.mjs';
import {
  CHECK_INTERVAL_MS,
  detectInstallMethod,
  isNewerVersion,
  maybeNotifyUpdate,
  runUpgradeCommand,
  shouldCheckUpdates,
  updateCachePath,
} from '../lib/update.mjs';

function captureStream() {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
}

test('isNewerVersion compares semantic versions accurately', () => {
  assert.equal(isNewerVersion('1.4.2', '1.4.1'), true);
  assert.equal(isNewerVersion('v2.0.0', '1.4.1'), true);
  assert.equal(isNewerVersion('1.4.1', '1.4.1-rc.1'), true);
  assert.equal(isNewerVersion('1.4.1', '1.4.1'), false);
  assert.equal(isNewerVersion('v1.4.0', '1.4.1'), false);
  assert.equal(isNewerVersion('1.4.1-beta.1', '1.4.1'), false);
});

test('shouldCheckUpdates respects skip rules', () => {
  assert.equal(shouldCheckUpdates({ command: 'export', argv: ['https://example.feishu.cn/docx/1'], env: {}, stderrIsTTY: true }), true);
  assert.equal(shouldCheckUpdates({ command: 'export', argv: ['--json'], env: {}, stderrIsTTY: true }), false);
  assert.equal(shouldCheckUpdates({ command: 'export', argv: [], env: {}, stderrIsTTY: false }), false);
  assert.equal(shouldCheckUpdates({ command: 'export', argv: [], env: { CI: 'true' }, stderrIsTTY: true }), false);
  assert.equal(shouldCheckUpdates({ command: 'export', argv: [], env: { FEISHU_GRAB_NO_UPDATE_CHECK: '1' }, stderrIsTTY: true }), false);
  for (const command of ['upgrade', 'completion', 'version', 'help']) {
    assert.equal(shouldCheckUpdates({ command, argv: [], env: {}, stderrIsTTY: true }), false);
  }
});

test('maybeNotifyUpdate handles fresh and stale caches cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-update-cache-'));
  const stateFile = join(dir, 'state.json');
  const cacheFile = updateCachePath(stateFile);
  const now = 1_700_000_000_000;
  try {
    // Missing cache spawns refresh without writing output
    const err1 = captureStream();
    const spawned1 = [];
    const notice1 = maybeNotifyUpdate({
      currentVersion: '1.4.1',
      command: 'config',
      stateFile,
      env: {},
      stderr: err1.stream,
      stderrIsTTY: true,
      now,
      spawnRefresh: (p) => spawned1.push(p),
    });
    assert.equal(notice1, null);
    assert.equal(err1.text(), '');
    assert.deepEqual(spawned1, [cacheFile]);

    // Fresh cache with newer version prints notice and does not spawn
    writeFileSync(cacheFile, JSON.stringify({ checkedAt: now - 60_000, latestVersion: '1.4.2' }));
    const err2 = captureStream();
    const spawned2 = [];
    const notice2 = maybeNotifyUpdate({
      currentVersion: '1.4.1',
      command: 'config',
      stateFile,
      env: {},
      stderr: err2.stream,
      stderrIsTTY: true,
      now,
      spawnRefresh: (p) => spawned2.push(p),
    });
    assert.match(err2.text(), /feishu-grab v1\.4\.2/);
    assert.match(err2.text(), /feishu-grab upgrade/);
    assert.equal(notice2.includes('1.4.2'), true);
    assert.deepEqual(spawned2, []);

    // Stale cache spawns refresh and still prints cached newer version
    writeFileSync(cacheFile, JSON.stringify({ checkedAt: now - CHECK_INTERVAL_MS - 1_000, latestVersion: '1.4.3' }));
    const err3 = captureStream();
    const spawned3 = [];
    maybeNotifyUpdate({
      currentVersion: '1.4.1',
      command: 'config',
      stateFile,
      env: {},
      stderr: err3.stream,
      stderrIsTTY: true,
      now,
      spawnRefresh: (p) => spawned3.push(p),
    });
    assert.match(err3.text(), /feishu-grab v1\.4\.3/);
    assert.deepEqual(spawned3, [cacheFile]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runUpgradeCommand supports --check --json and mocked Homebrew upgrade', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-upgrade-cmd-'));
  const stateFile = join(dir, 'state.json');
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: 'v1.5.0',
      html_url: 'https://github.com/Popcornnnnnnnn/feishu-doc-grabber/releases/tag/v1.5.0',
      draft: false,
      prerelease: false,
    }),
  });
  try {
    assert.equal(detectInstallMethod('/opt/homebrew/Cellar/feishu-grab/1.4.1/libexec/lib/update.mjs'), 'homebrew');
    assert.equal(detectInstallMethod('/Users/example/feishu-doc-grabber/lib/update.mjs'), 'source');

    const out1 = captureStream();
    const err1 = captureStream();
    await runUpgradeCommand(['--check', '--json'], {
      currentVersion: '1.4.1',
      stdout: out1.stream,
      stderr: err1.stream,
      stateFile,
      fetchImpl: mockFetch,
      moduleUrl: '/opt/homebrew/Cellar/feishu-grab/1.4.1/libexec/lib/update.mjs',
    });
    const payload = JSON.parse(out1.text());
    assert.equal(payload.current, '1.4.1');
    assert.equal(payload.latest, '1.5.0');
    assert.equal(payload.updateAvailable, true);
    assert.equal(payload.installMethod, 'homebrew');
    assert.equal(JSON.parse(readFileSync(updateCachePath(stateFile), 'utf8')).latestVersion, '1.5.0');

    const ran = [];
    const out2 = captureStream();
    await runUpgradeCommand([], {
      currentVersion: '1.4.1',
      stdout: out2.stream,
      stderr: err1.stream,
      stateFile,
      fetchImpl: mockFetch,
      runCommand: (cmd, args) => {
        ran.push([cmd, args]);
        return 0;
      },
      moduleUrl: '/opt/homebrew/Cellar/feishu-grab/1.4.1/libexec/lib/update.mjs',
    });
    assert.deepEqual(ran, [
      ['brew', ['update']],
      ['brew', ['upgrade', 'Popcornnnnnnnn/tap/feishu-grab']],
    ]);

    const out3 = captureStream();
    await runUpgradeCommand([], {
      currentVersion: '1.5.0',
      stdout: out3.stream,
      stderr: err1.stream,
      stateFile,
      fetchImpl: mockFetch,
    });
    assert.match(out3.text(), /already up to date/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('help works for upgrade command', async () => {
  const out = captureStream();
  await runCLI(['upgrade', '--help'], { stdout: out.stream, stderrIsTTY: false });
  assert.match(out.text(), /feishu-grab upgrade/);
});
