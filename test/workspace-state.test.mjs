import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  resolveDefaultOut,
  saveDefaultOut,
  saveLastReport,
  saveWorkspace,
  savedDefaultOut,
  savedLastReport,
  savedWorkspace,
} from '../lib/workspace-state.mjs';

const directory = mkdtempSync(join(tmpdir(), 'feishu-grab-state-'));
const path = join(directory, 'state.json');

test.after(() => rmSync(directory, { recursive: true, force: true }));

test('the tenant is remembered so later searches need no site', () => {
  assert.equal(savedWorkspace(path), null);
  saveWorkspace('https://example.feishu.cn/drive/home/', path);
  assert.equal(savedWorkspace(path), 'https://example.feishu.cn/drive/home/');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).workspace, 'https://example.feishu.cn/drive/home/');
});

test('default output and last report merge cleanly without clobbering workspace', () => {
  saveWorkspace('https://example.feishu.cn/drive/home/', path);
  assert.equal(savedDefaultOut(path), null);
  assert.equal(resolveDefaultOut(path, '/tmp/demo-cwd'), join(homedir(), 'Downloads'));

  saveDefaultOut({ mode: 'cwd' }, path);
  assert.deepEqual(savedDefaultOut(path), { mode: 'cwd' });
  assert.equal(resolveDefaultOut(path, '/tmp/demo-cwd'), '/tmp/demo-cwd');
  assert.equal(savedWorkspace(path), 'https://example.feishu.cn/drive/home/');

  saveDefaultOut({ mode: 'dir', path: '/tmp/custom-exports' }, path);
  assert.deepEqual(savedDefaultOut(path), { mode: 'dir', path: resolve('/tmp/custom-exports') });
  assert.equal(resolveDefaultOut(path, '/tmp/demo-cwd'), resolve('/tmp/custom-exports'));

  saveLastReport('/tmp/custom-exports/export-report.json', path);
  assert.equal(savedLastReport(path), resolve('/tmp/custom-exports/export-report.json'));
  assert.equal(savedWorkspace(path), 'https://example.feishu.cn/drive/home/');

  saveDefaultOut(null, path);
  assert.equal(savedDefaultOut(path), null);
  assert.equal(savedLastReport(path), resolve('/tmp/custom-exports/export-report.json'));
  assert.equal(savedWorkspace(path), 'https://example.feishu.cn/drive/home/');
});

test('unreadable or malformed state never breaks state reads', () => {
  writeFileSync(path, 'not json');
  assert.equal(savedWorkspace(path), null);
  assert.equal(savedDefaultOut(path), null);
  assert.equal(savedLastReport(path), null);
  writeFileSync(path, JSON.stringify({ workspace: 42, defaultOut: 'bad', lastReport: 99 }));
  assert.equal(savedWorkspace(path), null);
  assert.equal(savedDefaultOut(path), null);
  assert.equal(savedLastReport(path), null);
  assert.equal(savedWorkspace(join(directory, 'missing.json')), null);
});
