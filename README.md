# feishu-doc-grabber

A command-line exporter for Feishu/Lark documents. On macOS, `feishu-grab` reuses the sign-in in your everyday Google Chrome. It runs through Chrome's AppleScript interface and requires no browser extension, copied profile, remote-debugging port, or separate sign-in.

## Install and use

Requires macOS, Node.js 20+, and Google Chrome. Install from this checkout:

```bash
npm install
npm link
```

Open a Feishu/Lark document in your daily Chrome. Enable **View → Developer → Allow JavaScript from Apple Events** once. If macOS asks, allow your terminal to control Google Chrome in **System Settings → Privacy & Security → Automation**. These permissions let local automation run JavaScript in Chrome pages; the CLI does not enable them automatically. Chrome [documents this setting](https://www.chromium.org/developers/applescript/).

```bash
feishu-grab --doctor
feishu-grab 'https://example.feishu.cn/wiki/TOKEN' --out ./exports
```

You can also export the active Chrome document or process a batch:

```bash
feishu-grab --current --out ./exports
feishu-grab <url-1> <url-2> --out ./exports
feishu-grab --list urls.txt --out ./exports
feishu-grab --retry ./exports/export-report.json --out ./exports/retry
```

Without global installation, use `node /absolute/path/to/feishu-doc-grabber/cli.mjs` with the same arguments. `npm run grab -- <url> --out ./exports` also uses daily Chrome.

Daily Chrome mode supports Markdown for `/docx/`, document `/wiki/`, and `/docs/` links. It reuses an existing document tab, or opens a temporary tab in the same site's existing Chrome window (otherwise the front Chrome window). With multiple profiles, keep the intended signed-in profile's window in front. Existing tabs are preserved; only temporary export tabs are closed. Chrome must remain running throughout the export. `--doctor` checks the automation connection; an actual export checks document access and server authentication.

Requests execute inside Chrome with its normal authentication. The daily mode does not read cookies, passwords, profile databases, or local storage, and does not grant additional document access. Browser CORS restrictions, CSRF-protected read APIs, unsupported content, and failed media are reported through the existing integrity checks; a produced file is not automatically a complete export. PDF, DOM HTML, network capture, and rendered fallback use the separate browser option below.

## Existing isolated-browser option

For the original Google Chrome for Testing workflow, install that browser at `/Applications/Google Chrome for Testing.app`, then sign in once:

```bash
feishu-chrome login
feishu-grab <url> --browser isolated --out ./exports
feishu-grab <url> --browser isolated --format pdf --out ./exports
```

`--browser isolated` automatically starts the existing isolated profile headlessly for Markdown. Direct `node grab.mjs` calls retain the isolated default for compatibility with the macOS app and existing integrations. The new `cli.mjs` entry point and installed `feishu-grab` command default to daily Chrome.

## macOS app

Build the self-contained Apple Silicon app:

```bash
./scripts/build-macos-app.sh
open "dist/Feishu Grabber.app"
```

After the new bundle builds and passes signature verification, the build script removes the legacy `dist/FeishuGrabber.app` bundle so macOS search does not index both names.

The app accepts one or more Feishu/Lark links, confirms the saved sign-in state after login, shows the integrity result for each document, opens the local result page, and retries non-complete exports. `Log in to Feishu` is the only action that intentionally opens Chrome for Testing; normal exports use the isolated profile headlessly.

Every batch also creates `index.html`, a local result page with per-document status and integrity details. Documents that did not reach `complete` are written to `retry-urls.txt` and can be rerun directly from the report:

```bash
feishu-grab --retry exports/export-report.json --out exports/retry
```

## Output and integrity

Each run writes Markdown, downloaded assets, `index.html`, `retry-urls.txt`, and `export-report.json`. Every document receives one verdict:

- `complete`: all checked dimensions have positive completeness evidence.
- `degraded`: a file was produced, but at least one dimension cannot be proven.
- `incomplete`: the source proves content or resources are missing.

Exit codes are `0` for complete, `1` for an operational failure, and `2` for degraded or incomplete output. See [Export Integrity Protocol v1](INTEGRITY.md) for the exact rules.

## Rendering is opt-in

The isolated-browser Markdown path never creates a Chrome for Testing tab. If SSR/API data is unavailable, it exits with a clear error instead of unexpectedly activating the browser.

Use `--render-fallback` only when DOM or screenshot fallback is acceptable:

```bash
feishu-grab <url> --browser isolated --render-fallback
```

On macOS this option may activate Chrome for Testing. Explicit `--format pdf`, `--format html`, and `--format capture` operations also require rendering. `--allow-focus` remains as a compatibility alias for `--render-fallback`.

The real-document compatibility matrix is documented in [Feishu Export Test Corpus](TEST-CORPUS.md); implementation notes are in [PLAN.md](PLAN.md).
