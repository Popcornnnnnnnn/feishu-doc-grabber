import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readAuthState } from '../tools/ai-chrome.mjs';

const sqlite = '/usr/bin/sqlite3';

function createProfile(rows) {
  const profile = mkdtempSync(join(tmpdir(), 'feishu-auth-'));
  const defaultProfile = join(profile, 'Default');
  const database = join(defaultProfile, 'Cookies');
  mkdirSync(defaultProfile, { recursive: true });
  const schema = `
    CREATE TABLE cookies (
      host_key TEXT,
      name TEXT,
      value TEXT,
      encrypted_value BLOB,
      expires_utc INTEGER
    );
  `;
  const result = spawnSync(sqlite, [database], { input: schema + rows, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return profile;
}

test('missing cookie database is signed out', () => {
  const profile = mkdtempSync(join(tmpdir(), 'feishu-auth-empty-'));
  try {
    assert.deepEqual(readAuthState(profile), { state: 'signed-out' });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('valid Feishu session markers are signed in', { skip: !existsSync(sqlite) }, () => {
  const future = `(CAST(strftime('%s', 'now') AS INTEGER) + 11644473600 + 3600) * 1000000`;
  const profile = createProfile(`
    INSERT INTO cookies VALUES ('.feishu.cn', 'session', '', X'01', ${future});
    INSERT INTO cookies VALUES ('.feishu.cn', 'session_list', '', X'02', ${future});
  `);
  try {
    assert.deepEqual(readAuthState(profile), { state: 'signed-in' });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('expired Feishu session markers are signed out', { skip: !existsSync(sqlite) }, () => {
  const profile = createProfile(`
    INSERT INTO cookies VALUES ('.feishu.cn', 'session', '', X'01', 1);
    INSERT INTO cookies VALUES ('.feishu.cn', 'sl_session', '', X'02', 1);
  `);
  try {
    assert.deepEqual(readAuthState(profile), { state: 'signed-out' });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
