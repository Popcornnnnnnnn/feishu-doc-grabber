import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { documentURL } from './daily-chrome.mjs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const COMMANDS = ['export', 'current', 'doctor', 'search', 'report', 'completion', 'help', 'version'];
export const EXPORT_OPTIONS = ['--out', '--list', '--retry', '--browser', '--format', '--timeout', '--current', '--render-fallback', '--help', '--version'];
export const SEARCH_OPTIONS = ['--site', '--limit', '--offset', '--timeout', '--json'];

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

export function parseExportArgs(argv, { defaultBrowser = 'isolated', requireInput = false } = {}) {
  const args = {
    urls: [], out: join(homedir(), 'Downloads'), list: null, retry: null,
    format: 'md', formatExplicit: false, timeoutMs: 180000, allowRender: false, browser: defaultBrowser,
  };
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (literal) { args.urls.push(raw); continue; }
    if (raw === '--') { literal = true; continue; }
    const equals = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const option = equals < 0 ? raw : raw.slice(0, equals);
    if (VALUE_OPTIONS.has(option)) {
      const value = equals < 0 ? argv[++i] : raw.slice(equals + 1);
      if (!value || (equals < 0 && value.startsWith('-'))) throw new UsageError(`${option} requires a value.`);
      const key = VALUE_OPTIONS.get(option);
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
  args.urls = args.urls.map((value) => {
    try { return documentURL(value).href; } catch { throw new UsageError('Use an HTTPS Feishu/Lark docx, wiki, or docs document link.'); }
  });
  return args;
}

export function helpText(command = null) {
  if (command && !COMMANDS.includes(command)) throw new UsageError(`Unknown command: ${command}`);
  const footer = `\nExit codes: 0 complete, 1 operational failure, 2 partial or unproven export, 64 invalid arguments.\n`;
  const exports = `Usage: feishu-grab ${command === 'current' ? 'current' : 'export <url> [url ...]'} [options]
       feishu-grab <url> [url ...] [options]

Export options:
  -o, --out <dir>          Output directory (default: ~/Downloads)
      --list <file>        Read URLs from a UTF-8 file; blank lines and # comments are ignored
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
  feishu-grab 'https://example.feishu.cn/wiki/TOKEN' --out ./exports
  feishu-grab current --out ./exports
  feishu-grab export --list urls.txt --out ./exports
  feishu-grab export --retry ./exports/export-report.json --out ./retry
`;
  if (command === 'export' || command === 'current') return `feishu-grab ${VERSION}\n\n${exports}${footer}`;
  const details = {
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
    help: 'Usage: feishu-grab help [command]\n',
    version: 'Usage: feishu-grab version\n',
  };
  if (command) return `feishu-grab ${VERSION}\n\n${details[command]}${footer}`;
  return `feishu-grab ${VERSION} — Export Feishu/Lark documents using your daily Chrome.

Usage: feishu-grab <command> [options]
       feishu-grab <url> [url ...] [options]

Commands:
  export      Export one or more documents as Markdown with assets and integrity reports
  current     Export the active Chrome document
  doctor      Check the daily Chrome connection
  search      Search documents and wiki knowledge bases with your signed-in session
  report      Inspect a saved export report
  completion  Print bash, zsh, or fish completions
  help        Show help for a command
  version     Show the installed version

Compatibility: --current, --doctor, --help, and --version are also supported.
Run 'feishu-grab help export' for all export options.
${exports.slice(exports.indexOf('Examples:'))}${footer}`;
}
