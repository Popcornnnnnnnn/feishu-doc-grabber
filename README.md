# feishu-doc-grabber

Local, integrity-aware Feishu/Lark document export. Markdown is the default and uses authenticated SSR/API data without opening Chrome tabs.

## Install

```bash
npm install
npm link
```

Install Google Chrome for Testing at `/Applications/Google Chrome for Testing.app`, then log in once. This command intentionally opens that isolated automation browser:

```bash
feishu-chrome login
```

After login, exports automatically start the isolated Chrome for Testing profile headlessly when needed. The launcher never falls back to the user's daily Google Chrome app:

```bash
feishu-grab 'https://example.feishu.cn/wiki/...' --out exports
```

Multiple URLs and text-file batches are supported:

```bash
feishu-grab <url-1> <url-2> --out exports
feishu-grab --list urls.txt --out exports
```

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

The default Markdown path never creates a Chrome for Testing tab. If SSR/API data is unavailable, it exits with a clear error instead of unexpectedly activating the browser.

Use `--render-fallback` only when DOM or screenshot fallback is acceptable:

```bash
feishu-grab <url> --render-fallback
```

On macOS this option may activate Chrome for Testing. Explicit `--format pdf`, `--format html`, and `--format capture` operations also require rendering. `--allow-focus` remains as a compatibility alias for `--render-fallback`.

The real-document compatibility matrix is documented in [Feishu Export Test Corpus](TEST-CORPUS.md); implementation notes are in [PLAN.md](PLAN.md).
