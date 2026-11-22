# feishu-doc-grabber Reference

Detailed CLI options, isolated browser workflow, Chrome extension preview, macOS app, and output protocol notes moved out of `README.md`.

## Commands & Options

```bash
feishu-grab --help
feishu-grab help export
feishu-grab --version
feishu-grab export <url> --out ./exports
feishu-grab current --out ./exports
feishu-grab doctor --json
feishu-grab report ./exports/export-report.json [--json]
feishu-grab completion zsh
man feishu-grab
```

- `--out`/`-o`, `--format`/`-f`, `--timeout`, `--browser`, `--list`, and `--retry` accept separate values or `--option=value`.
- Homebrew installs `man feishu-grab` and bash/zsh/fish completions (`completion` prints scripts without editing shell rc files).
- `doctor --json` checks the automation connection (not document authentication); `report --json` echoes the report and exits according to its verdicts.
- Daily Chrome mode supports Markdown for `/docx/`, document `/wiki/`, and `/docs/` links; it reuses an open document tab or opens a temporary tab in the front Chrome window and leaves existing tabs intact.

## Isolated Chrome for Testing & Rendering Fallback

For PDF, DOM HTML, network capture, or rendered fallback, install `/Applications/Google Chrome for Testing.app`:

```bash
feishu-chrome login
feishu-grab <url> --browser isolated --out ./exports
feishu-grab <url> --browser isolated --format pdf --out ./exports
feishu-grab <url> --browser isolated --render-fallback
```

- `--browser isolated` runs headlessly for Markdown unless `--render-fallback` (alias `--allow-focus`), `--format pdf`, `--format html`, or `--format capture` is specified.
- Direct `node grab.mjs` calls keep `--browser isolated` as default for compatibility with the macOS app; `cli.mjs` and `feishu-grab` default to daily Chrome.

## Chrome Extension Preview

```bash
npm run build:extension    # builds dist/Feishu Grabber Extension/
npm run test:extension     # headless integration suite with synthetic responses
```

Load `dist/Feishu Grabber Extension/` via Chrome's **Load unpacked**, open a Feishu/Lark document, and click the toolbar icon to export a ZIP (Markdown + assets + integrity report) using that Chrome profile's existing session. See [extension/README.md](../extension/README.md).

## macOS App

```bash
./scripts/build-macos-app.sh
open "dist/Feishu Grabber.app"
```

Accepts document URLs, verifies saved login state, shows per-document integrity status, opens the generated `index.html` batch summary, and retries incomplete items via `retry-urls.txt`.

## Output Files & Integrity Verdicts

Each export writes Markdown, downloaded assets, `index.html`, `retry-urls.txt`, and `export-report.json`. Verdicts:

- `complete` (exit `0`): all checked dimensions have positive completeness evidence.
- `degraded` (exit `2`): output was written, but at least one dimension could not be proven.
- `incomplete` (exit `2`): source proves content or resources are missing.
- Exit `1`: operational failure; exit `64`: invalid arguments or report schema. See [INTEGRITY.md](../INTEGRITY.md).
