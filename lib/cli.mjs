import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DailyChrome } from './daily-chrome.mjs';
import {
  COMMANDS,
  CONFIG_OPTIONS,
  EXPORT_OPTIONS,
  SEARCH_OPTIONS,
  VERSION,
  UsageError,
  helpText,
  parseExportArgs,
  parseFolderFlag,
} from './cli-options.mjs';
import { extractDocumentURLsFromLines, parseDocumentInput } from './links.mjs';
import { formatSearchResults } from './search.mjs';
import { searchKnowledgeBase } from './search-backend.mjs';
import {
  resolveDefaultOut,
  saveDefaultOut,
  savedDefaultOut,
  savedLastReport,
  savedWorkspace,
  statePath,
} from './workspace-state.mjs';

export function completionText(shell) {
  const words = [...COMMANDS, ...EXPORT_OPTIONS, ...SEARCH_OPTIONS, ...CONFIG_OPTIONS];
  if (shell === 'bash') return `_feishu_grab() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
    --browser) COMPREPLY=( $(compgen -W 'chrome isolated' -- "$cur") ); return ;;
    --format|-f) COMPREPLY=( $(compgen -W 'md pdf html capture' -- "$cur") ); return ;;
    completion) COMPREPLY=( $(compgen -W 'bash zsh fish' -- "$cur") ); return ;;
    --out|-o|--folder) COMPREPLY=( $(compgen -d -- "$cur") ); return ;;
    --list|--retry|report|retry) COMPREPLY=( $(compgen -f -- "$cur") ); return ;;
  esac
  COMPREPLY=( $(compgen -W '${words.join(' ')}' -- "$cur") )
}
complete -F _feishu_grab feishu-grab
`;
  if (shell === 'zsh') return `#compdef feishu-grab
_feishu_grab() {
  local -a commands
  commands=(${COMMANDS.map((command) => `'${command}'`).join(' ')})
  _arguments -s \\
    '-h[Show help]' '--help[Show help]' '-V[Show version]' '--version[Show version]' \\
    '--folder[Output directory (current directory if omitted)]:directory:_directories' \\
    '-o[Output directory]:directory:_directories' '--out[Output directory]:directory:_directories' \\
    '--reset[Reset default output]' \\
    '--list[URL list]:file:_files' '--retry[Previous report]:file:_files' \\
    '--browser[Browser]:browser:(chrome isolated)' \\
    '-f[Format]:format:(md pdf html capture)' '--format[Format]:format:(md pdf html capture)' \\
    '--timeout[Timeout in seconds]:seconds:' '--current[Export active document]' \\
    '--doctor[Check Chrome]' '--render-fallback[Allow isolated rendering]' '--json[Print JSON]' \\
    '1:command:(${COMMANDS.join(' ')})' '*:argument:->argument'
  if [[ "$state" == argument ]]; then
    case "$words[2]" in
      completion) _values shell bash zsh fish ;;
      help) _describe command commands ;;
      *) _files ;;
    esac
  fi
}
_feishu_grab "$@"
`;
  if (shell === 'fish') return `complete -c feishu-grab -f
complete -c feishu-grab -n '__fish_use_subcommand' -a '${COMMANDS.join(' ')}'
complete -c feishu-grab -s h -l help -d 'Show help'
complete -c feishu-grab -s V -l version -d 'Show version'
complete -c feishu-grab -l folder -a '(__fish_complete_directories)'
complete -c feishu-grab -s o -l out -r -a '(__fish_complete_directories)'
complete -c feishu-grab -l reset
complete -c feishu-grab -l list -r -F
complete -c feishu-grab -l retry -r -F
complete -c feishu-grab -l browser -r -a 'chrome isolated'
complete -c feishu-grab -s f -l format -r -a 'md pdf html capture'
complete -c feishu-grab -l timeout -r
complete -c feishu-grab -l current
complete -c feishu-grab -l doctor
complete -c feishu-grab -l render-fallback
complete -c feishu-grab -l json
complete -c feishu-grab -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
`;
  throw new UsageError('Choose a completion shell: bash, zsh, or fish.');
}

export function inspectReport(path) {
  let report;
  try { report = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Could not read the export report: ${error.message}`); }
  if (!report || report.schemaVersion !== 1 || !Array.isArray(report.documents)) throw new UsageError('Expected a schemaVersion 1 export report with a documents array.');
  const counts = { complete: 0, degraded: 0, incomplete: 0, failed: 0 };
  for (const document of report.documents) {
    if (!document || !['success', 'failed'].includes(document.operationalStatus)
        || !['complete', 'degraded', 'incomplete'].includes(document.integrity?.verdict)) {
      throw new UsageError('The export report contains an invalid document result.');
    }
    counts[document.integrity.verdict]++;
    if (document.operationalStatus === 'failed') counts.failed++;
  }
  return { report, counts, exitCode: counts.failed ? 1 : counts.degraded || counts.incomplete ? 2 : 0 };
}

function readAll(stream) {
  return new Promise((resolveStream, rejectStream) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    stream.on('end', () => resolveStream(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', rejectStream);
  });
}

function promptLine(prompt, { stdin, stdout }) {
  return new Promise((resolvePrompt) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolvePrompt(value);
    };
    rl.once('close', () => finish(null));
    rl.question(prompt, (answer) => finish(answer));
  });
}

function promptLines(header, { stdin, stdout }) {
  return new Promise((resolvePrompt) => {
    stdout.write(`${header}\n`);
    const rl = createInterface({ input: stdin, output: stdout, prompt: '  > ', terminal: Boolean(stdin.isTTY) });
    const lines = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      rl.close();
      resolvePrompt(lines);
    };
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) { finish(); return; }
      lines.push(trimmed);
      rl.prompt();
    });
    rl.once('close', finish);
    rl.prompt();
  });
}

function parseUrlsOrUsageError(fn) {
  try { return fn(); }
  catch (error) { throw new UsageError(error.message); }
}

function toGrabArgs(parsed) {
  const args = ['--browser', parsed.browser, '--out', parsed.out, '--timeout', String(parsed.timeoutMs / 1000)];
  if (parsed.formatExplicit) args.push('--format', parsed.format);
  if (parsed.allowRender) args.push('--render-fallback');
  if (parsed.current) args.push('--current');
  if (parsed.list) args.push('--list', parsed.list);
  if (parsed.retry) args.push('--retry', parsed.retry);
  if (parsed.urls.length) args.push('--', ...parsed.urls);
  return args;
}

function parseRetryArgs(rest, stateFile) {
  const optionTokens = [];
  const reportPaths = [];
  const valueFlags = new Set(['--out', '-o', '--browser', '--format', '-f', '--timeout']);
  const blockedFlags = new Set(['--current', '--doctor', '--list', '--retry']);
  let literal = false;

  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i];
    if (literal) { reportPaths.push(raw); continue; }
    if (raw === '--') { literal = true; continue; }
    const equals = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const option = equals < 0 ? raw : raw.slice(0, equals);
    if (blockedFlags.has(option)) throw new UsageError(`retry cannot be combined with ${option}.`);
    if (option === '--folder') {
      if (equals >= 0) {
        optionTokens.push(raw);
      } else {
        const next = rest[i + 1];
        if (next === undefined || next.startsWith('-') || next.endsWith('.json')) {
          optionTokens.push('--folder');
        } else {
          if (next === '') throw new UsageError('--folder requires a directory path.');
          optionTokens.push('--folder', rest[++i]);
        }
      }
    } else if (valueFlags.has(option)) {
      optionTokens.push(raw);
      if (equals < 0) {
        const next = rest[++i];
        if (next !== undefined) optionTokens.push(next);
      }
    } else if (raw.startsWith('-')) {
      optionTokens.push(raw);
    } else {
      reportPaths.push(raw);
    }
  }

  if (reportPaths.length > 1) throw new UsageError('Use: feishu-grab retry [export-report.json] [options]');
  const parsed = parseExportArgs(optionTokens, { defaultBrowser: 'chrome', requireInput: false, stateFile });
  const reportPath = reportPaths[0] ?? savedLastReport(stateFile);
  if (!reportPath) {
    throw new Error('No recent export report found. Run an export first or pass a report path: feishu-grab retry <export-report.json>.');
  }
  if (!existsSync(reportPath)) {
    throw new Error(`Export report not found: ${reportPath}`);
  }
  parsed.retry = reportPath;
  if (!parsed.outExplicit) parsed.out = dirname(resolve(reportPath));
  return parsed;
}

function handleConfigCommand(rest, { stdout, stateFile }) {
  let json = false;
  let reset = false;
  let nextOut;
  let outSource = null;

  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i];
    if (raw === '--json') { json = true; continue; }
    if (raw === '--reset') {
      if (outSource) throw new UsageError('Use either --reset or --folder/--out, not both.');
      reset = true;
      continue;
    }
    const equals = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const option = equals < 0 ? raw : raw.slice(0, equals);
    if (option === '--folder') {
      if (reset) throw new UsageError('Use either --reset or --folder/--out, not both.');
      if (outSource === 'out') throw new UsageError('Use either --folder or --out, not both.');
      const parsed = parseFolderFlag(rest, i, raw, equals);
      i = parsed.nextIndex;
      nextOut = parsed.value ? { mode: 'dir', path: parsed.value } : { mode: 'cwd' };
      outSource = 'folder';
    } else if (option === '--out' || option === '-o') {
      if (reset) throw new UsageError('Use either --reset or --folder/--out, not both.');
      if (outSource === 'folder') throw new UsageError('Use either --folder or --out, not both.');
      const value = equals < 0 ? rest[++i] : raw.slice(equals + 1);
      if (!value || (equals < 0 && value.startsWith('-'))) throw new UsageError(`${option} requires a value.`);
      nextOut = { mode: 'dir', path: value };
      outSource = 'out';
    } else if (raw.startsWith('-')) {
      throw new UsageError(`Unknown option: ${raw}`);
    } else {
      throw new UsageError('Use: feishu-grab config [--folder [dir] | --out <dir> | --reset] [--json]');
    }
  }

  let changed = false;
  if (reset) { saveDefaultOut(null, stateFile); changed = true; }
  else if (nextOut !== undefined) { saveDefaultOut(nextOut, stateFile); changed = true; }

  const defaultOut = savedDefaultOut(stateFile);
  const resolvedOut = resolveDefaultOut(stateFile);
  const workspace = savedWorkspace(stateFile);
  const lastReport = savedLastReport(stateFile);

  if (json) {
    stdout.write(`${JSON.stringify({ defaultOut, resolvedOut, workspace, lastReport }, null, 2)}\n`);
    return;
  }
  const label = defaultOut?.mode === 'cwd' ? `Current folder (${resolvedOut})` : resolvedOut;
  stdout.write(`${changed ? 'Saved default output' : 'Default output'}: ${label}\n`);
  if (workspace) stdout.write(`Saved workspace: ${workspace}\n`);
  if (lastReport) stdout.write(`Last report: ${lastReport}\n`);
}

export async function runCLI(argv, io = {}) {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const isTTY = io.isTTY ?? Boolean(stdin.isTTY);
  const stateFile = io.stateFile ?? statePath();
  const runMain = io.runMain ?? (async (forwardedArgs) => {
    const { main } = await import('../grab.mjs');
    return main(forwardedArgs);
  });

  let command = 'export';
  let explicitCommand = false;
  let rest = [...argv];
  if (!rest.length) command = 'interactive';
  else if (COMMANDS.includes(rest[0])) { command = rest.shift(); explicitCommand = true; }
  else if (rest[0] === '--doctor') { command = 'doctor'; rest.shift(); }
  else if (rest[0] === '--current') { command = 'current'; rest.shift(); }
  else if (rest[0] === '--version' || rest[0] === '-v' || rest[0] === '-V') { command = 'version'; rest.shift(); }
  else if (rest[0] === '--help' || rest[0] === '-h') { command = 'help'; rest.shift(); }
  else if (!rest[0].startsWith('-') && !/https?:\/\//i.test(rest[0])) throw new UsageError(`Unknown command: ${rest[0]}`);

  if (rest.includes('--help') || rest.includes('-h')) {
    stdout.write(helpText(command === 'interactive' ? null : command));
    return;
  }
  if (rest.some((argument) => ['--version', '-V', '-v'].includes(argument))) {
    stdout.write(VERSION + '\n');
    return;
  }
  if (command === 'help') {
    if (rest.length > 1) throw new UsageError('Use: feishu-grab help [command]');
    stdout.write(helpText(rest[0]));
    return;
  }
  if (command === 'version') {
    if (rest.length) throw new UsageError('The version command does not take arguments.');
    stdout.write(VERSION + '\n');
    return;
  }
  if (command === 'completion') {
    if (rest.length !== 1) throw new UsageError('Use: feishu-grab completion <bash|zsh|fish>');
    stdout.write(completionText(rest[0]));
    return;
  }
  if (command === 'config') {
    handleConfigCommand(rest, { stdout, stateFile });
    return;
  }
  if (command === 'report') {
    const json = rest.includes('--json');
    const paths = rest.filter((arg) => arg !== '--json');
    if (paths.length !== 1 || paths[0].startsWith('-')) throw new UsageError('Use: feishu-grab report <export-report.json> [--json]');
    const { report, counts, exitCode } = inspectReport(paths[0]);
    stdout.write(json ? JSON.stringify(report, null, 2) + '\n'
      : `${report.documents.length} document(s): ${counts.complete} complete, ${counts.degraded} degraded, ${counts.incomplete} incomplete, ${counts.failed} failed\n`
        + report.documents.map((document) => `[${document.operationalStatus === 'failed' ? 'failed' : document.integrity.verdict}] ${document.output || document.url || '(no output)'}${document.error ? `: ${document.error}` : ''}\n`).join(''));
    process.exitCode = exitCode;
    return;
  }
  if (command === 'doctor') {
    const json = rest.includes('--json');
    for (const option of rest.filter((arg) => arg.startsWith('-'))) {
      if (!['--json', '--timeout', '--browser'].includes(option.split('=')[0])) throw new UsageError(`Unsupported doctor option: ${option}`);
    }
    const args = parseExportArgs(['--doctor', ...rest.filter((arg) => arg !== '--json')], { defaultBrowser: 'chrome', stateFile });
    if (args.browser !== 'chrome') throw new UsageError('doctor checks daily Chrome; use feishu-chrome status for the isolated browser.');
    try {
      const result = await new DailyChrome({ timeoutMs: args.timeoutMs }).doctor({ quiet: json });
      if (json) stdout.write(JSON.stringify(result) + '\n');
    } catch (error) {
      if (!json) throw error;
      stdout.write(JSON.stringify({ browser: 'chrome', connected: false, error: error.message }) + '\n');
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'search') {
    const options = { json: false, site: null, limit: 20, offset: 0, timeoutMs: 180000 };
    const query = [];
    for (let i = 0; i < rest.length; i++) {
      const argument = rest[i];
      if (argument === '--json') { options.json = true; continue; }
      const equals = argument.indexOf('=');
      const name = equals > 0 ? argument.slice(0, equals) : argument;
      if (!SEARCH_OPTIONS.includes(name)) {
        if (argument.startsWith('-')) throw new UsageError(`Unknown option: ${argument}`);
        query.push(argument);
        continue;
      }
      const value = equals > 0 ? argument.slice(equals + 1) : rest[++i];
      if (!value || (equals < 0 && value.startsWith('-'))) throw new UsageError(`${name} requires a value.`);
      if (name === '--site') options.site = value;
      else if (name === '--limit') options.limit = Number(value);
      else if (name === '--offset') options.offset = Number(value);
      else if (name === '--timeout') options.timeoutMs = Number(value) * 1000;
    }
    if (query.length !== 1) throw new UsageError('Use: feishu-grab search <query> [--site <url>] [--limit <n>] [--offset <n>] [--json]');
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new UsageError('--limit must be a whole number between 1 and 100.');
    if (!Number.isInteger(options.offset) || options.offset < 0) throw new UsageError('--offset must be zero or a positive whole number.');
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new UsageError('--timeout must be a positive number of seconds.');
    const { result } = await searchKnowledgeBase(query[0], {
      count: options.limit, offset: options.offset, site: options.site, timeoutMs: options.timeoutMs,
    });
    stdout.write(options.json ? JSON.stringify(result, null, 2) + '\n' : formatSearchResults(result));
    return;
  }
  if (command === 'retry') {
    const parsed = parseRetryArgs(rest, stateFile);
    await runMain(toGrabArgs(parsed));
    return;
  }
  if (command === 'batch') {
    const parsed = parseExportArgs(rest, { defaultBrowser: 'chrome', requireInput: false, stateFile });
    if (parsed.doctor || parsed.current || parsed.retry) {
      throw new UsageError('batch cannot be combined with --doctor, --current, or --retry.');
    }
    if (!parsed.urls.length && !parsed.list) {
      const text = isTTY
        ? (await promptLines('Paste Feishu links or share text (one per line; blank line starts export):', { stdin, stdout })).join('\n')
        : await readAll(stdin);
      const urls = parseUrlsOrUsageError(() => extractDocumentURLsFromLines(text));
      if (!urls.length) throw new UsageError('Provide at least one Feishu/Lark document link.');
      parsed.urls = urls;
    }
    await runMain(toGrabArgs(parsed));
    return;
  }
  if (command === 'interactive') {
    if (!isTTY) {
      const piped = (await readAll(stdin)).trim();
      if (!piped) {
        stdout.write(helpText());
        return;
      }
      const urls = parseUrlsOrUsageError(() => extractDocumentURLsFromLines(piped));
      if (!urls.length) throw new UsageError('Use an HTTPS Feishu/Lark docx, wiki, or docs document link.');
      const parsed = parseExportArgs(urls, { defaultBrowser: 'chrome', requireInput: true, stateFile });
      await runMain(toGrabArgs(parsed));
      return;
    }
    stdout.write(`Output: ${resolveDefaultOut(stateFile)}\n`);
    const line = await promptLine('Paste a Feishu link (no quotes needed, Enter for active Chrome tab): ', { stdin, stdout });
    if (line === null) return;
    const trimmed = line.trim();
    const parsed = trimmed
      ? parseExportArgs([trimmed], { defaultBrowser: 'chrome', requireInput: true, stateFile })
      : parseExportArgs(['--current'], { defaultBrowser: 'chrome', requireInput: true, stateFile });
    await runMain(toGrabArgs(parsed));
    return;
  }

  if (command === 'current') rest.unshift('--current');
  const parsed = parseExportArgs(rest, { defaultBrowser: 'chrome', requireInput: explicitCommand, stateFile });
  if (!parsed.doctor && !parsed.urls.length && !parsed.list && !parsed.retry && !parsed.current) {
    if (isTTY) {
      stdout.write(`Output: ${parsed.out}\n`);
      const line = await promptLine('Paste a Feishu link (no quotes needed, Enter for active Chrome tab): ', { stdin, stdout });
      if (line === null) return;
      const trimmed = line.trim();
      if (!trimmed) {
        if (parsed.browser !== 'chrome') throw new UsageError('--current requires --browser chrome.');
        parsed.current = true;
      } else {
        parsed.urls = parseUrlsOrUsageError(() => parseDocumentInput(trimmed));
      }
    } else {
      const piped = (await readAll(stdin)).trim();
      if (!piped) throw new UsageError('Provide a document URL, --list, --retry, or --current.');
      parsed.urls = parseUrlsOrUsageError(() => extractDocumentURLsFromLines(piped));
      if (!parsed.urls.length) throw new UsageError('Provide a document URL, --list, --retry, or --current.');
    }
  }
  await runMain(toGrabArgs(parsed));
}
