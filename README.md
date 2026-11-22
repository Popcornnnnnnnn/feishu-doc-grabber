# feishu-doc-grabber

A command-line exporter for Feishu/Lark documents. On macOS, `feishu-grab` reuses the sign-in in your everyday Google Chrome. It runs through Chrome's AppleScript interface and requires no browser extension, copied profile, remote-debugging port, or separate sign-in.

## Install

With [Homebrew](https://brew.sh/):

```bash
brew install Popcornnnnnnnn/tap/feishu-grab
feishu-grab
```

macOS only. Homebrew installs Node.js, the manual page, shell completions, `feishu-grab`, `feishu-grab-mcp`, and `feishu-chrome`.

To update:

```bash
brew update
brew upgrade feishu-grab
```

For development from this checkout, use Node.js 22.12 or newer:

```bash
npm install
npm link
```

Open a Feishu/Lark document in your daily Chrome. Enable **View → Developer → Allow JavaScript from Apple Events** once. If macOS asks, allow your terminal to control Google Chrome in **System Settings → Privacy & Security → Automation**. These permissions let local automation run JavaScript in Chrome pages; the CLI does not enable them automatically. Chrome [documents this setting](https://www.chromium.org/developers/applescript/).

## Use

The simplest way avoids shell quoting entirely:

```bash
feishu-grab                                   # paste a link or share text; Enter exports the active Chrome tab
feishu-grab --folder                          # paste a link; save to the current folder
feishu-grab --folder ~/Exports
feishu-grab 'https://example.feishu.cn/wiki/TOKEN' --folder
```

You can also export the active Chrome document, run interactive or piped batches, configure your default folder, and retry incomplete documents with zero arguments:

```bash
feishu-grab current --folder                  # export the active Chrome tab to the current folder
feishu-grab batch                             # paste multiple links or share text; blank line starts export
feishu-grab batch 'URL1' 'URL2' --folder
feishu-grab batch --folder < urls.txt
feishu-grab retry                             # retry failed/incomplete docs from your latest export
feishu-grab retry ./exports/export-report.json
feishu-grab config                            # view default output folder
feishu-grab config --folder                   # default to the current folder on each run
feishu-grab config --folder ~/Exports         # default to a fixed folder
feishu-grab config --reset                    # reset default output back to ~/Downloads
feishu-grab doctor                            # check Chrome AppleScript connection
```

Without global installation, use `node /path/to/feishu-doc-grabber/cli.mjs` with the same arguments. `npm run grab -- <url> --folder` also uses daily Chrome.

Daily Chrome mode supports Markdown for `/docx/`, document `/wiki/`, and `/docs/` links (including Feishu share text containing a URL). It reuses an existing document tab, or opens a temporary tab in the same site's existing Chrome window (otherwise the front Chrome window). With multiple profiles, keep the intended signed-in profile's window in front. Existing tabs are preserved; only temporary export tabs are closed. Chrome must remain running throughout the export. `doctor` checks the automation connection; an actual export checks document access and server authentication.

Requests execute inside Chrome with its normal authentication. The daily mode does not read cookies, passwords, profile databases, or local storage, and does not grant additional document access. Browser CORS restrictions, CSRF-protected read APIs, unsupported content, and failed media are reported through the existing integrity checks; a produced file is not automatically a complete export. PDF, DOM HTML, network capture, and rendered fallback use `--browser isolated` below.

## Commands and reference

```bash
feishu-grab --help
feishu-grab help export
feishu-grab --version
feishu-grab export <url> --folder ./exports
feishu-grab batch --list urls.txt --folder ./exports
feishu-grab current --folder
feishu-grab retry
feishu-grab config --json
feishu-grab doctor --json
feishu-grab report ./exports/export-report.json --json
feishu-grab completion zsh
man feishu-grab
```

Homebrew installs the manual page and bash/zsh/fish completions. `completion` prints definitions without modifying your shell configuration.
`--folder [dir]` saves to `dir`, or the current working directory if omitted (smart lookahead treats `--folder URL` as current directory).
`--out`/`-o`, `--format`/`-f`, `--timeout`, `--browser`, `--list`, and `--retry` accept separate values; long options also support `--option=value`.
Unknown options, missing values, invalid links, and incompatible browser modes fail before browser access.
Use `--help` on any command for its options. Direct URL usage and the `--current` / `--doctor` aliases remain supported.

`doctor --json` reports connection state; a connected result does not prove document authentication.
`report --json` prints the original report and returns a status based on its results.
See [release maintenance](docs/releasing.md) and [version history](CHANGELOG.md).

## Search

Find documents and wiki knowledge-base pages with the same signed-in session:

```bash
feishu-grab search '会议纪要' --limit 10
feishu-grab search '季度规划' --json
```

This is the document/wiki index, not Feishu's all-in-one search: chat messages are never
searched or returned. Results come from your account, so they match exactly what you can
open, and every link can be passed straight to `feishu-grab`.

Search prefers BrowserOS neo when it is running: the request runs in a Feishu tab there, so
your everyday Chrome is never touched. Without BrowserOS it falls back to reusing an open
Feishu tab in Chrome, and it never opens a page. The first run records your tenant in
`~/.feishu-grab.json`, so later searches need no `--site`. `--offset` pages through results;
`--json` returns `{ total, hasMore, items[] }` for agents.

## MCP server

`feishu-grab-mcp` speaks the Model Context Protocol over stdio, so any MCP client can search,
read, and export without shelling out:

```bash
feishu-grab-mcp        # after brew install or npm link
node /path/to/feishu-doc-grabber/mcp/server.mjs
```

It exposes three tools:

- `feishu_search` — `{ query, limit?, offset?, site?, json? }`, documents and wiki knowledge bases only.
- `feishu_read` — `{ url, format? }`, read a document, wiki page, sheet, or attached file (`.docx`, `.pdf`, text) in the background via BrowserOS neo.
- `feishu_export` — `{ urls[], out?, timeout? }`, Markdown export with an integrity report.

Client configuration uses the usual shape:

```json
{ "mcpServers": { "feishu-grab": { "command": "feishu-grab-mcp" } } }
```

`feishu-grab help search` documents the same behavior for CLI use; the MCP server and the
CLI share the transport, allowlist, and tenant memory.

## Existing isolated-browser option

For the original Google Chrome for Testing workflow, install that browser at `/Applications/Google Chrome for Testing.app`, then sign in once:

```bash
feishu-chrome login
feishu-grab <url> --browser isolated --out ./exports
feishu-grab <url> --browser isolated --format pdf --out ./exports
```

`--browser isolated` automatically starts the existing isolated profile headlessly for Markdown. Direct `node grab.mjs` calls retain the isolated default for compatibility with the macOS app and existing integrations. The `feishu-grab` CLI defaults to daily Chrome.

## Chrome extension preview

Build the extension with `npm run build:extension`. Load the generated
`dist/Feishu Grabber Extension/` folder through Chrome's **Load unpacked** command,
then click the extension icon while viewing a Feishu/Lark document. A small toolbar
popup detects the current document; click **Export**. The icon is disabled on
unrelated pages. Exports continue after the popup closes; reopen it to see progress
and results. Keep Chrome and the source document open. The extension uses that Chrome profile's existing sign-in and saves a ZIP containing Markdown,
local assets, and an integrity report. The popup settings also support folder
output, a download subfolder, ZIP save-location prompts, and System/Light/Dark appearance. It does not require the desktop app or Node
on the user's computer. See [extension setup and limits](extension/README.md).

Run `npm run test:extension` for the headless Chrome extension integration suite.
It uses synthetic Feishu responses and a temporary profile; it does not count as
live-account compatibility verification.

## macOS app

Build the self-contained Apple Silicon app:

```bash
./scripts/build-macos-app.sh
open "dist/Feishu Grabber.app"
```

After the new bundle builds and passes signature verification, the build script removes the legacy `dist/FeishuGrabber.app` bundle so macOS search does not index both names.

The app accepts one or more Feishu/Lark links, confirms the saved sign-in state after login, shows the integrity result for each document, opens the local result page, and retries non-complete exports. `Log in to Feishu` is the only action that intentionally opens Chrome for Testing; normal exports use the isolated profile headlessly.

Every batch also creates `index.html`, a local result page with per-document status and integrity details. Documents that did not reach `complete` are written to `retry-urls.txt` and can be rerun directly from `feishu-grab retry`:

```bash
feishu-grab retry exports/export-report.json --out exports/retry
```

## Output and integrity

Each run writes Markdown, downloaded assets, `index.html`, `retry-urls.txt`, and `export-report.json`. Every document receives one verdict:

- `complete`: all checked dimensions have positive completeness evidence.
- `degraded`: a file was produced, but at least one dimension cannot be proven.
- `incomplete`: the source proves content or resources are missing.

Exit codes are `0` for complete, `1` for an operational failure, `2` for degraded or incomplete output, and `64` for invalid arguments or report schemas. See [Export Integrity Protocol v1](INTEGRITY.md) for the exact rules.

## Rendering is opt-in

The isolated-browser Markdown path never creates a Chrome for Testing tab. If SSR/API data is unavailable, it exits with a clear error instead of unexpectedly activating the browser.

Use `--render-fallback` only when DOM or screenshot fallback is acceptable:

```bash
feishu-grab <url> --browser isolated --render-fallback
```

On macOS this option may activate Chrome for Testing. Explicit `--format pdf`, `--format html`, and `--format capture` operations also require rendering. `--allow-focus` remains as a compatibility alias for `--render-fallback`.

The real-document compatibility matrix is documented in [Feishu Export Test Corpus](TEST-CORPUS.md); implementation notes are in [PLAN.md](PLAN.md).


<!-- workspace-maintenance:start -->
## 维护与问题入口

代码与必要文档沿用 [GitHub 仓库](https://github.com/Popcornnnnnnnn/feishu-doc-grabber)；需跟进的问题统一从 [Issues](https://github.com/Popcornnnnnnnn/feishu-doc-grabber/issues) 接续，先查重，再记录进展与完成条件。
项目功能与验收沿用已有记录。
<!-- workspace-maintenance:end -->
