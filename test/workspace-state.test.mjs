import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { saveWorkspace, savedWorkspace } from '../lib/workspace-state.mjs';

const directory = mkdtempSync(join(tmpdir(), 'feishu-grab-state-'));
const path = join(directory, 'state.json');

test.after(() => rmSync(directory, { recursive: true, force: true }));

test('the tenant is remembered so later searches need no site', () => {
  assert.equal(savedWorkspace(path), null);
  saveWorkspace('https://example.feishu.cn/drive/home/', path);
  assert.equal(savedWorkspace(path), 'https://example.feishu.cn/drive/home/');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).workspace, 'https://example.feishu.cn/drive/home/');
});

test('unreadable or malformed state never breaks a search', () => {
  writeFileSync(path, 'not json');
  assert.equal(savedWorkspace(path), null);
  writeFileSync(path, JSON.stringify({ workspace: 42 }));
  assert.equal(savedWorkspace(path), null);
  assert.equal(savedWorkspace(join(directory, 'missing.json')), null);
});
