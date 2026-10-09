import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseExportArgs, VERSION } from '../lib/cli-options.mjs';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const source = 'https://example.feishu.cn/docx/Document';
const cli = (...args) => spawnSync(process.execPath, ['cli.mjs', ...args], { cwd, encoding: 'utf8' });

test('CLI help and version work for every command without browser access', () => {
  for (const args of [[], ['--help'], ['help'], ['export', '--help'], ['help', 'export'], ['current', '-h'], ['doctor', '--help'], ['report', '--help'], ['completion', '--help']]) {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, '');
  }
  for (const args of [['version'], ['--version'], ['-v'], ['-V'], ['current', '--version'], ['doctor', '--version']]) {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), VERSION);
  }
});

test('invalid options, missing values, malformed URLs, and incompatible modes fail before browser access', () => {
  const cases = [
    ['exprot'], ['export'], ['--unknown'], ['export', source, '--out'],
    ['export', source, '--format', 'xml'], ['export', source, '--browser=firefox'],
    ['export', source, '--timeout=NaN'], ['export', source, '--timeout=Infinity'],
    ['export', source, '--timeout=-1'], ['export', source, '--timeout=0'],
    ['export', source, '--current=true'], ['export', source, '--render-fallback'],
    ['current', '--browser=isolated'], ['export', 'http://example.feishu.cn/docx/Document'],
    ['export', 'https://example.feishu.cn.evil.test/docx/Document'],
    ['doctor', '--list=urls.txt'], ['doctor', '--browser=isolated'],
    ['report'], ['completion', 'powershell'], ['version', 'extra'],
  ];
  for (const args of cases) {
    const result = cli(...args);
    assert.equal(result.status, 64, JSON.stringify(args) + ': ' + result.stderr);
    assert.match(result.stderr, /feishu-grab --help/);
    assert.equal(result.stdout, '');
  }
});

test('export parser supports equals, short aliases, decimals, and explicit isolated mode', () => {
  const args = parseExportArgs([source, '--browser=isolated', '-f', 'pdf', '-o', '/tmp/results', '--timeout=0.25']);
  assert.equal(args.browser, 'isolated');
  assert.equal(args.format, 'pdf');
  assert.equal(args.formatExplicit, true);
  assert.equal(args.out, '/tmp/results');
  assert.equal(args.timeoutMs, 250);
  assert.deepEqual(args.urls, [source]);
});

test('report command preserves its JSON and reflects partial and failed outcomes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-cli-report-'));
  const path = join(dir, 'report.json');
  try {
    for (const [status, verdict, exit] of [['success', 'complete', 0], ['success', 'degraded', 2], ['success', 'incomplete', 2], ['failed', 'incomplete', 1]]) {
      const report = { schemaVersion: 1, documents: [{ url: source, output: '/tmp/报告.md', operationalStatus: status, integrity: { verdict } }] };
      writeFileSync(path, JSON.stringify(report));
      const result = cli('report', path, '--json');
      assert.equal(result.status, exit, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), report);
      assert.equal(result.stderr, '');
    }
    writeFileSync(path, '{}');
    assert.equal(cli('report', path).status, 64);
    writeFileSync(path, 'null');
    assert.equal(cli('report', path).status, 64);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('completions include commands and validate their shell syntax', () => {
  for (const shell of ['bash', 'zsh', 'fish']) {
    const result = cli('completion', shell);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /feishu-grab/);
    assert.match(result.stdout, /doctor/);
    if (shell !== 'fish') {
      const checked = spawnSync(`/bin/${shell}`, ['-n'], { input: result.stdout, encoding: 'utf8' });
      assert.equal(checked.status, 0, checked.stderr);
    }
  }
});

test('empty batches and invalid links in batch files fail before browser access', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-cli-list-'));
  const path = join(dir, 'urls.txt');
  try {
    for (const contents of ['# empty list\n\n', 'https://example.com/docx/Document\n']) {
      writeFileSync(path, contents);
      const result = cli('export', '--list', path);
      assert.equal(result.status, 64, result.stderr);
      assert.equal(result.stdout, '');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
