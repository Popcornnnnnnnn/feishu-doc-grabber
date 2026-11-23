import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocumentInput } from './links.mjs';
import { resolveDefaultOut } from './workspace-state.mjs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const COMMANDS = ['export', 'batch', 'current', 'retry', 'config', 'doctor', 'search', 'report', 'completion', 'upgrade', 'help', 'version'];
export const EXPORT_OPTIONS = ['--out', '--folder', '--list', '--retry', '--browser', '--format', '--timeout', '--current', '--render-fallback', '--help', '--version'];
export const SEARCH_OPTIONS = ['--site', '--limit', '--offset', '--timeout', '--json'];
export const CONFIG_OPTIONS = ['--folder', '--out', '--reset', '--json'];

export class UsageError extends Error {
  constructor(message) { super(message); this.exitCode = 64; }
}

const VALUE_OPTIONS = new Map([
  ['--out', 'out'], ['-o', 'out'], ['--list', 'list'], ['--retry', 'retry'],
  ['--browser', 'browser'], ['--format', 'format'], ['-f', 'format'], ['--timeout', 'timeout'],
]);
const SWITCHES = new Map([
  ['--current', 'current'], ['--doctor', 'doctor'], ['--render-fallback', 'allowRender'],
  ['--allow-focus', 'allowRender'], ['--help', 'help'], ['-h', 'help'],
  ['--version', 'version'], ['-v', 'version'], ['-V', 'version'],
]);

/** Parses `--folder [DIR]` with URL lookahead so `--folder URL` saves to the current folder. */
export function parseFolderFlag(argv, index, raw, equals) {
  if (equals >= 0) {
    const value = raw.slice(equals + 1);
    if (!value) throw new UsageError('--folder requires a value.');
    return { value, nextIndex: index };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-') || /https?:\/\//i.test(next)) {
    return { value: null, nextIndex: index };
  }
  if (next === '') throw new UsageError('--folder requires a directory path.');
  return { value: next, nextIndex: index + 1 };
}

export function parseExportArgs(argv, { defaultBrowser = 'isolated', requireInput = false, defaultOut = null, stateFile = undefined } = {}) {
  const args = {
    urls: [],
    out: defaultOut ?? resolveDefaultOut(stateFile),
    outExplicit: false,
    outSource: null,
    list: null,
    retry: null,
    format: 'md',
    formatExplicit: false,
    timeoutMs: 180000,
    allowRender: false,
    browser: defaultBrowser,
  };
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (literal) { args.urls.push(raw); continue; }
    if (raw === '--') { literal = true; continue; }
    const equals = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const option = equals < 0 ? raw : raw.slice(0, equals);
    if (option === '--folder') {
      if (args.outSource === 'out') throw new UsageError('Use either --folder or --out, not both.');
      const parsed = parseFolderFlag(argv, i, raw, equals);
      i = parsed.nextIndex;
      args.out = parsed.value ? resolve(parsed.value) : process.cwd();
      args.outExplicit = true;
      args.outSource = 'folder';
    } else if (VALUE_OPTIONS.has(option)) {
      const value = equals < 0 ? argv[++i] : raw.slice(equals + 1);
      if (!value || (equals < 0 && value.startsWith('-'))) throw new UsageError(`${option} requires a value.`);
      const key = VALUE_OPTIONS.get(option);
      if (key === 'out') {
        if (args.outSource === 'folder') throw new UsageError('Use either --folder or --out, not both.');
        args.outExplicit = true;
        args.outSource = 'out';
      }
      if (key === 'timeout') {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647) throw new UsageError('--timeout must be a positive number of seconds below 2147483.647.');
        args.timeoutMs = seconds * 1000;
      } else args[key] = value;
      if (key === 'format') args.formatExplicit = true;
    } else if (SWITCHES.has(option)) {
      if (equals >= 0) throw new UsageError(`${option} does not take a value.`);
      args[SWITCHES.get(option)] = true;
    } else if (raw.startsWith('-')) throw new UsageError(`Unknown option: ${raw}`);
    else args.urls.push(raw);
  }
  if (!['chrome', 'isolated'].includes(args.browser)) throw new UsageError('Use --browser chrome or --browser isolated.');
  if (!['md', 'pdf', 'html', 'capture'].includes(args.format)) throw new UsageError('Use --format md, pdf, html, or capture.');
  if (args.help || args.version) return args;
  if (args.doctor && (args.urls.length || args.list || args.retry || args.current)) throw new UsageError('--doctor cannot be combined with an export source.');
  if (args.browser === 'chrome' && (args.format !== 'md' || args.allowRender)) throw new UsageError('Daily Chrome supports Markdown through SSR/API. For PDF, HTML, capture, or rendered fallback, use --browser isolated.');
  if (args.current && args.browser !== 'chrome') throw new UsageError('--current requires --browser chrome.');
  if (requireInput && !args.doctor && !args.urls.length && !args.list && !args.retry && !args.current) throw new UsageError('Provide a document URL, --list, --retry, or --current.');

  const normalized = [];
  for (const value of args.urls) {
    let extracted;
    try {
      extracted = parseDocumentInput(value);
    } catch {
      throw new UsageError('Use an HTTPS Feishu/Lark docx, wiki, or docs document link.');
    }
    for (const url of extracted) {
      if (!normalized.includes(url)) normalized.push(url);
    }
  }
  args.urls = normalized;
  return args;
}

export function helpText(command = null) {
  if (command && !COMMANDS.includes(command)) throw new UsageError(`Unknown command: ${command}`);
  const footer = `\nExit codes: 0 complete, 1 operational failure, 2 partial or unproven export, 64 invalid arguments.\n`;
  const exports = `Usage: feishu-grab ${command === 'current' ? 'current' : 'export <url> [url ...]'} [options]
       feishu-grab <url> [url ...] [options]

Export options:
      --folder [dir]       Save to DIR, or the current folder if omitted
  -o, --out <dir>          Save to DIR (default: configured folder, or ~/Downloads)
      --list <file>        Read URLs or share text from a UTF-8 file; # comments ignored
      --retry <report>     Retry failed, degraded, or incomplete documents from a report
      --current            Include the active document in daily Chrome
      --browser <name>     chrome (default) or isolated (Chrome for Testing)
  -f, --format <format>    md (default), pdf, html, or capture
      --timeout <seconds>  Request timeout (default: 180)
      --render-fallback    Allow DOM/screenshot fallback in isolated mode
  -h, --help               Show help
  -V, --version            Show version (-v is also accepted)

Daily Chrome requires macOS and Chrome's Allow JavaScript from Apple Events setting.
Daily Chrome supports Markdown. PDF, HTML, capture, and rendering use --browser isolated.
Keep the intended Chrome profile's document window open throughout export.

Examples:
  feishu-grab                              Paste a link or share text (Enter exports active tab)
  feishu-grab 'https://example.feishu.cn/wiki/TOKEN'
  feishu-grab 'https://example.feishu.cn/wiki/TOKEN' --folder
  feishu-grab batch                        Paste multiple links; blank line starts export
  feishu-grab current --folder             Export the active Chrome document
  feishu-grab retry                        Retry incomplete docs from the last export
  feishu-grab config --folder              Default to the current folder on each run
  feishu-grab search 'keyword'             Search docs and wikis in your signed-in session
  feishu-grab doctor                       Check daily Chrome automation
  feishu-grab upgrade                      Check for updates and upgrade feishu-grab
`;
  if (command === 'export' || command === 'current') return `feishu-grab ${VERSION}\n\n${exports}${footer}`;
  const details = {
    batch: `Usage: feishu-grab batch [url ...] [options]

Export multiple Feishu/Lark documents at once.
If no links or --list are supplied, paste one link or share-text line per line in
the terminal (blank line starts export) or pipe URLs on standard input.

Options:
      --folder [dir]       Save to DIR, or the current folder if omitted
  -o, --out <dir>          Save to DIR
      --list <file>        Read URLs or share text from a UTF-8 file
      --browser <name>     chrome (default) or isolated
  -f, --format <format>    md (default), pdf, html, or capture
      --timeout <seconds>  Request timeout (default: 180)
      --render-fallback    Allow DOM/screenshot fallback in isolated mode

Examples:
  feishu-grab batch --folder
  feishu-grab batch 'URL1' 'URL2' --folder ./exports
  feishu-grab batch --folder ./exports < urls.txt
`,
    retry: `Usage: feishu-grab retry [export-report.json] [options]

Retry failed, degraded, or incomplete documents from the latest export report,
or from a specified report file. When no output folder is given, results are
written alongside the report.

Options:
      --folder [dir]       Save retry results to DIR, or the current folder if omitted
  -o, --out <dir>          Save retry results to DIR
      --browser <name>     chrome (default) or isolated
  -f, --format <format>    Override the report format (md, pdf, html, capture)
      --timeout <seconds>  Request timeout (default: 180)
      --render-fallback    Allow DOM/screenshot fallback in isolated mode

Examples:
  feishu-grab retry
  feishu-grab retry --folder ./retry
  feishu-grab retry ./exports/export-report.json
`,
    config: `Usage: feishu-grab config [options]

View or change the default output folder stored in ~/.feishu-grab.json.
Per-run --folder or --out options override the saved default without changing it.

Options:
      --folder [dir]       Default to DIR, or the current folder on each run if omitted
  -o, --out <dir>          Default to DIR
      --reset              Reset default output back to ~/Downloads
      --json               Print machine-readable state

Examples:
  feishu-grab config
  feishu-grab config --folder
  feishu-grab config --folder ~/Documents/Feishu
  feishu-grab config --reset
`,
    doctor: 'Usage: feishu-grab doctor [--json] [--timeout <seconds>]\n\nCheck daily Chrome and its AppleScript connection. Document access is checked during export.\nCompatibility alias: feishu-grab --doctor\n',
    search: `Usage: feishu-grab search <query> [options]

Search Feishu/Lark documents and wiki knowledge bases with your signed-in session.
Chat messages are never searched or returned. BrowserOS neo is used when it is running;
otherwise an open Feishu tab in Chrome is reused and no page is ever opened.

Options:
      --site <url>         Workspace page to run in (default: the open Feishu tab, then the last used tenant)
      --limit <n>          Results per page, 1-100 (default: 20)
      --offset <n>         Skip this many results (default: 0)
      --timeout <seconds>  Request timeout (default: 180)
      --json               Print the full machine-readable result

Results come from the signed-in account, so they match what that account can open.
`,
    report: 'Usage: feishu-grab report <export-report.json> [--json]\n\nInspect an existing export report without connecting to Chrome.\n--json prints the original machine-readable report. Exit status reflects its results.\n',
    completion: 'Usage: feishu-grab completion <bash|zsh|fish>\n\nPrint shell completion definitions. Homebrew installs these automatically.\n',
    upgrade: 'Usage: feishu-grab upgrade [--check] [--json]\n\nCheck for new feishu-grab releases and upgrade via Homebrew.\n',
    help: 'Usage: feishu-grab help [command]\n',
    version: 'Usage: feishu-grab version\n',
  };
  if (command) return `feishu-grab ${VERSION}\n\n${details[command]}${footer}`;
  return `feishu-grab ${VERSION} — Export Feishu/Lark documents using your daily Chrome.

Usage: feishu-grab [command] [options]
       feishu-grab <url-or-share-text> [options]

Commands:
  export      Export one or more documents as Markdown with assets and integrity reports
  batch       Export multiple links (args, paste multi-line, --list, or stdin)
  current     Export the active Chrome document
  retry       Retry incomplete docs from the latest or specified export report
  config      View or change the default output folder
  doctor      Check the daily Chrome connection
  search      Search documents and wiki knowledge bases with your signed-in session
  report      Inspect a saved export report
  completion  Print bash, zsh, or fish completions
  upgrade     Check for updates and upgrade feishu-grab
  help        Show help for a command
  version     Show the installed version

Compatibility: --current, --doctor, --help, and --version are also supported.
Run 'feishu-grab help export' for all export options.
${exports.slice(exports.indexOf('Examples:'))}${footer}`;
}
