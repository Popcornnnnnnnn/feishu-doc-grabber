import { readFileSync } from 'node:fs';
import { DailyChrome } from './daily-chrome.mjs';
import { COMMANDS, EXPORT_OPTIONS, VERSION, UsageError, helpText, parseExportArgs } from './cli-options.mjs';

export function completionText(shell) {
  const words = [...COMMANDS, ...EXPORT_OPTIONS, '--json'];
  if (shell === 'bash') return `_feishu_grab() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
    --browser) COMPREPLY=( $(compgen -W 'chrome isolated' -- "$cur") ); return ;;
    --format|-f) COMPREPLY=( $(compgen -W 'md pdf html capture' -- "$cur") ); return ;;
    completion) COMPREPLY=( $(compgen -W 'bash zsh fish' -- "$cur") ); return ;;
    --out|-o) COMPREPLY=( $(compgen -d -- "$cur") ); return ;;
    --list|--retry|report) COMPREPLY=( $(compgen -f -- "$cur") ); return ;;
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
    '-o[Output directory]:directory:_directories' '--out[Output directory]:directory:_directories' \\
    '--list[URL list]:file:_files' '--retry[Previous report]:file:_files' \\
    '--browser[Browser]:browser:(chrome isolated)' \\
    '-f[Format]:format:(md pdf html capture)' '--format[Format]:format:(md pdf html capture)' \\
    '--timeout[Timeout in seconds]:seconds:' '--current[Export active document]' \\
    '--doctor[Check Chrome]' '--render-fallback[Allow isolated rendering]' '--json[Print JSON]' \\
    '1:command:(export current doctor report completion help version)' '*:argument:->argument'
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
complete -c feishu-grab -s o -l out -r -a '(__fish_complete_directories)'
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

export async function runCLI(argv) {
  let command = 'export';
  let rest = [...argv];
  if (!rest.length) command = 'help';
  else if (COMMANDS.includes(rest[0])) command = rest.shift();
  else if (rest[0] === '--doctor') { command = 'doctor'; rest.shift(); }
  else if (rest[0] === '--current') { command = 'current'; rest.shift(); }
  else if (rest[0] === '--version' || rest[0] === '-v' || rest[0] === '-V') { command = 'version'; rest.shift(); }
  else if (rest[0] === '--help' || rest[0] === '-h') { command = 'help'; rest.shift(); }
  else if (!rest[0].startsWith('-') && !/^https?:\/\//i.test(rest[0])) throw new UsageError(`Unknown command: ${rest[0]}`);

  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(helpText(command));
    return;
  }
  if (rest.some((argument) => ['--version', '-V', '-v'].includes(argument))) {
    process.stdout.write(VERSION + '\n');
    return;
  }
  if (command === 'help') {
    if (rest.length > 1) throw new UsageError('Use: feishu-grab help [command]');
    process.stdout.write(helpText(rest[0]));
    return;
  }
  if (command === 'version') {
    if (rest.length) throw new UsageError('The version command does not take arguments.');
    process.stdout.write(VERSION + '\n');
    return;
  }
  if (command === 'completion') {
    if (rest.length !== 1) throw new UsageError('Use: feishu-grab completion <bash|zsh|fish>');
    process.stdout.write(completionText(rest[0]));
    return;
  }
  if (command === 'report') {
    const json = rest.includes('--json');
    const paths = rest.filter((arg) => arg !== '--json');
    if (paths.length !== 1 || paths[0].startsWith('-')) throw new UsageError('Use: feishu-grab report <export-report.json> [--json]');
    const { report, counts, exitCode } = inspectReport(paths[0]);
    process.stdout.write(json ? JSON.stringify(report, null, 2) + '\n'
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
    const args = parseExportArgs(['--doctor', ...rest.filter((arg) => arg !== '--json')], { defaultBrowser: 'chrome' });
    if (args.browser !== 'chrome') throw new UsageError('doctor checks daily Chrome; use feishu-chrome status for the isolated browser.');
    try {
      const result = await new DailyChrome({ timeoutMs: args.timeoutMs }).doctor({ quiet: json });
      if (json) process.stdout.write(JSON.stringify(result) + '\n');
    } catch (error) {
      if (!json) throw error;
      process.stdout.write(JSON.stringify({ browser: 'chrome', connected: false, error: error.message }) + '\n');
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'current') rest.unshift('--current');
  parseExportArgs(rest, { defaultBrowser: 'chrome', requireInput: true });
  const { main } = await import('../grab.mjs');
  await main(['--browser', 'chrome', ...rest]);
}
