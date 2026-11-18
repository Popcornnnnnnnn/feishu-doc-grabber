# Changelog

## Unreleased

- Add `search`, finding documents and wiki knowledge bases through the signed-in session; chat messages are never searched.
- Add `feishu-grab-mcp`, a stdio MCP server exposing `feishu_search` and `feishu_export` to any agent harness.
- Run searches through BrowserOS neo when it is running, so the everyday Chrome is never touched; Chrome is a reuse-only fallback.
- Remember the tenant in `~/.feishu-grab.json` so later searches need no `--site`.
- Allow the read-only `/space/api/search/search_wiki/` request from document and workspace pages, and nothing broader.
- Accept `/drive/home/`, `/wiki/home/`, and `/next/messenger/` as workspace pages for search.

## 1.3.2

- Use explicit tab characters in Chrome inventory so the browser dictionary cannot mask the delimiter.
- Match Chrome's text identifiers when selecting windows and executing in or closing tabs.
- Add regressions for Chrome identifiers, document selection, and temporary-tab cleanup.

## 1.3.1

- Await the page target before opening its authentication session in isolated mode.
- Add a full mocked export regression covering body, comments, output files, and integrity.
- Allow manually replaying the release workflow against an existing version tag.

## 1.3.0

- Install a pinned release with Homebrew, including a manual page and shell completions.
- Add `export`, `current`, `doctor`, `report`, `completion`, `help`, and `version` commands.
- Keep URL-first usage, `--current`, `--doctor`, and the explicit isolated browser option.
- Validate options, missing values, HTTPS document links, and incompatible modes before browser access.
- Support `--option=value`, `-o`, `-f`, `-h`, `-V`, and `-v`.
- Inspect saved reports and Chrome connection state as JSON.
- Use exit code 64 for argument errors, alongside existing export codes 0, 1, and 2.
- Reuse daily Chrome through AppleScript without browser extensions or exporting authentication data.

Daily Chrome mode supports Markdown on macOS. Completeness still depends on document access,
browser restrictions, supported content, and the evidence recorded in each export report.
