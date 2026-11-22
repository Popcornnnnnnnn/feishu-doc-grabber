import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseExportArgs, VERSION } from '../lib/cli-options.mjs';
import { runCLI } from '../lib/cli.mjs';
import { saveWorkspace } from '../lib/workspace-state.mjs';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const source = 'https://example.feishu.cn/docx/Document';
const sourceTwo = 'https://example.feishu.cn/wiki/WikiTwo';
const cli = (...args) => spawnSync(process.execPath, ['cli.mjs', ...args], { cwd, encoding: 'utf8' });
const cliWithEnv = (env, ...args) => spawnSync(process.execPath, ['cli.mjs', ...args], {
  cwd,
  encoding: 'utf8',
  env: { ...process.env, ...env },
});

function captureOutput() {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) { text += chunk.toString(); callback(); },
  });
  return { stream, text: () => text };
}

test('CLI help and version work for every command without browser access', () => {
  for (const args of [
    [], ['--help'], ['help'], ['export', '--help'], ['help', 'export'],
    ['batch', '--help'], ['help', 'batch'], ['retry', '--help'], ['help', 'retry'],
    ['config', '--help'], ['help', 'config'], ['current', '-h'],
    ['doctor', '--help'], ['report', '--help'], ['completion', '--help'],
  ]) {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, '');
  }
  for (const args of [['version'], ['--version'], ['-v'], ['-V'], ['current', '--version'], ['doctor', '--version'], ['batch', '--version']]) {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), VERSION);
  }
});

test('invalid options, missing values, malformed URLs, and incompatible modes fail before browser access', () => {
  const cases = [
    ['exprot'], ['export'], ['--unknown'], ['export', source, '--out'],
    ['export', source, '--folder', '--out', '/tmp/a'], ['export', source, '--out', '/tmp/a', '--folder'],
    ['export', source, '--folder='], ['export', source, '--format', 'xml'],
    ['export', source, '--browser=firefox'], ['export', source, '--timeout=NaN'],
    ['export', source, '--timeout=Infinity'], ['export', source, '--timeout=-1'],
    ['export', source, '--timeout=0'], ['export', source, '--current=true'],
    ['export', source, '--render-fallback'], ['current', '--browser=isolated'],
    ['export', 'http://example.feishu.cn/docx/Document'],
    ['export', 'https://example.feishu.cn.evil.test/docx/Document'],
    ['batch'], ['batch', '--current'], ['batch', '--doctor'], ['batch', '--retry', 'r.json'],
    ['retry', 'a.json', 'b.json'], ['retry', '--list', 'urls.txt'], ['retry', '--current'],
    ['config', 'extra'], ['config', '--folder', '--out', '/tmp/a'], ['config', '--reset', '--folder'],
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

test('export parser supports equals, short aliases, decimals, --folder lookahead, share text, and explicit isolated mode', () => {
  const args = parseExportArgs([source, '--browser=isolated', '-f', 'pdf', '-o', '/tmp/results', '--timeout=0.25']);
  assert.equal(args.browser, 'isolated');
  assert.equal(args.format, 'pdf');
  assert.equal(args.formatExplicit, true);
  assert.equal(args.out, '/tmp/results');
  assert.equal(args.timeoutMs, 250);
  assert.deepEqual(args.urls, [source]);

  const folderLookahead = parseExportArgs(['--folder', source]);
  assert.equal(folderLookahead.out, process.cwd());
  assert.equal(folderLookahead.outExplicit, true);
  assert.deepEqual(folderLookahead.urls, [source]);

  const folderDir = parseExportArgs([source, '--folder', './my-exports']);
  assert.equal(folderDir.out, resolve('./my-exports'));

  const folderEq = parseExportArgs([source, '--folder=./eq-exports']);
  assert.equal(folderEq.out, resolve('./eq-exports'));

  const shareText = parseExportArgs([`【飞书文档】项目周会 ${source} 请查收`]);
  assert.deepEqual(shareText.urls, [source]);
});

test('config command views, sets, resets, and isolates default output without clobbering workspace state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-cli-config-'));
  const stateFile = join(dir, 'state.json');
  try {
    saveWorkspace('https://example.feishu.cn/drive/home/', stateFile);

    const initial = cliWithEnv({ FEISHU_GRAB_STATE: stateFile }, 'config', '--json');
    assert.equal(initial.status, 0, initial.stderr);
    assert.deepEqual(JSON.parse(initial.stdout), {
      defaultOut: null,
      resolvedOut: join(homedir(), 'Downloads'),
      workspace: 'https://example.feishu.cn/drive/home/',
      lastReport: null,
    });

    const setCwd = cliWithEnv({ FEISHU_GRAB_STATE: stateFile }, 'config', '--folder');
    assert.equal(setCwd.status, 0, setCwd.stderr);
    assert.match(setCwd.stdout, /Saved default output: Current folder/);
    assert.match(setCwd.stdout, /Saved workspace: https:\/\/example\.feishu\.cn\/drive\/home\//);

    const parsedDefaults = parseExportArgs([source], { stateFile });
    assert.equal(parsedDefaults.out, process.cwd());

    const customDir = join(dir, 'exports');
    const setFixed = cliWithEnv({ FEISHU_GRAB_STATE: stateFile }, 'config', '--folder', customDir);
    assert.equal(setFixed.status, 0, setFixed.stderr);
    assert.match(setFixed.stdout, /Saved default output:/);
    assert.equal(parseExportArgs([source], { stateFile }).out, resolve(customDir));

    const reset = cliWithEnv({ FEISHU_GRAB_STATE: stateFile }, 'config', '--reset', '--json');
    assert.equal(reset.status, 0, reset.stderr);
    const afterReset = JSON.parse(reset.stdout);
    assert.equal(afterReset.defaultOut, null);
    assert.equal(afterReset.workspace, 'https://example.feishu.cn/drive/home/');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retry command validates missing saved or explicit reports before browser access', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-cli-retry-'));
  const stateFile = join(dir, 'state.json');
  try {
    const noSaved = cliWithEnv({ FEISHU_GRAB_STATE: stateFile }, 'retry');
    assert.equal(noSaved.status, 1);
    assert.match(noSaved.stderr, /No recent export report found/);

    const missingFile = cliWithEnv({ FEISHU_GRAB_STATE: stateFile }, 'retry', join(dir, 'missing.json'));
    assert.equal(missingFile.status, 1);
    assert.match(missingFile.stderr, /Export report not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('interactive prompt supports link paste, share text, Enter for active tab, EOF, and batch paste', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-cli-interactive-'));
  const stateFile = join(dir, 'state.json');
  try {
    // 1. Bare interactive prompt with pasted share text
    {
      const stdin = new PassThrough();
      const out = captureOutput();
      let forwarded = null;
      const promise = runCLI([], {
        stdin, stdout: out.stream, isTTY: true, stateFile,
        runMain: async (args) => { forwarded = args; },
      });
      stdin.end(`【飞书文档】周报 ${source}！\n`);
      await promise;
      assert.match(out.text(), /Paste a Feishu link/);
      assert.ok(forwarded.includes('--') && forwarded.includes(source));
    }

    // 2. Bare interactive prompt with blank Enter -> --current
    {
      const stdin = new PassThrough();
      const out = captureOutput();
      let forwarded = null;
      const promise = runCLI(['--folder'], {
        stdin, stdout: out.stream, isTTY: true, stateFile,
        runMain: async (args) => { forwarded = args; },
      });
      stdin.end('\n');
      await promise;
      assert.ok(forwarded.includes('--current'));
      assert.equal(forwarded[forwarded.indexOf('--out') + 1], process.cwd());
    }

    // 3. Bare interactive prompt with immediate EOF exits cleanly without running export
    {
      const stdin = new PassThrough();
      const out = captureOutput();
      let called = false;
      const promise = runCLI([], {
        stdin, stdout: out.stream, isTTY: true, stateFile,
        runMain: async () => { called = true; },
      });
      stdin.end();
      await promise;
      assert.equal(called, false);
    }

    // 4. Interactive batch multi-line paste ending on blank line
    {
      const stdin = new PassThrough();
      const out = captureOutput();
      let forwarded = null;
      const promise = runCLI(['batch', '--folder', dir], {
        stdin, stdout: out.stream, isTTY: true, stateFile,
        runMain: async (args) => { forwarded = args; },
      });
      stdin.end(`${source}\n分享 ${sourceTwo}\n\n`);
      await promise;
      assert.match(out.text(), /blank line starts export/);
      assert.equal(forwarded[forwarded.indexOf('--out') + 1], resolve(dir));
      assert.ok(forwarded.includes(source));
      assert.ok(forwarded.includes(sourceTwo));
    }

    // 5. Non-TTY piped stdin works for both bare CLI and batch
    {
      const stdin = new PassThrough();
      const out = captureOutput();
      let forwarded = null;
      const promise = runCLI([], {
        stdin, stdout: out.stream, isTTY: false, stateFile,
        runMain: async (args) => { forwarded = args; },
      });
      stdin.end(`${source}\n${sourceTwo}\n`);
      await promise;
      assert.ok(forwarded.includes(source));
      assert.ok(forwarded.includes(sourceTwo));
    }

    // 6. Zero-arg retry picks up lastReport and defaults output to report directory
    {
      const reportDir = join(dir, 'last-run');
      const reportPath = join(reportDir, 'export-report.json');
      const fs = await import('node:fs');
      fs.mkdirSync(reportDir, { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, documents: [] }));
      const { saveLastReport } = await import('../lib/workspace-state.mjs');
      saveLastReport(reportPath, stateFile);

      let forwarded = null;
      const out = captureOutput();
      await runCLI(['retry'], {
        stdin: new PassThrough(), stdout: out.stream, isTTY: false, stateFile,
        runMain: async (args) => { forwarded = args; },
      });
      assert.equal(forwarded[forwarded.indexOf('--retry') + 1], reportPath);
      assert.equal(forwarded[forwarded.indexOf('--out') + 1], resolve(reportDir));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    assert.match(result.stdout, /batch/);
    assert.match(result.stdout, /retry/);
    assert.match(result.stdout, /config/);
    assert.match(result.stdout, /folder/);
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
