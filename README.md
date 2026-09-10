# feishu-doc-grabber

Local Feishu/Lark document export through an isolated Chrome profile. Markdown export prefers SSR block data and falls back to rendered DOM extraction when required.

```bash
npm install
node tools/ai-chrome.mjs start
node grab.mjs 'https://example.feishu.cn/wiki/...' --format md --out out
```

Every run writes `export-report.json` with a `complete`, `degraded`, or `incomplete` verdict. See [Export Integrity Protocol v1](INTEGRITY.md) for the evidence rules and exit codes.

The real-document coverage matrix is tracked separately in [Feishu Export Test Corpus](TEST-CORPUS.md). Prepared local fixtures do not count as live coverage.

The exporter runs without taking window focus by default. Canvas-only whiteboard and sheet screenshots require the explicit `--allow-focus` option.

Implementation notes and current limitations are tracked in [PLAN.md](PLAN.md).
