# Changelog

## 1.4.1

- Add non-blocking daily update check against GitHub Releases (interactive terminal only; set `FEISHU_GRAB_NO_UPDATE_CHECK=1` to disable).
- Add `feishu-grab upgrade` (with `--check` and `--json`) to check for updates and upgrade via Homebrew.

## 1.4.0

- Add interactive paste mode when running bare `feishu-grab` in a terminal (no shell quoting needed; press Enter to export the active Chrome tab), plus piped stdin URL reading.
- Extract Feishu/Lark document URLs directly from pasted share text and wrapped quotes/punctuation.
- Add `--folder [dir]` shorthand (saves to the current folder when omitted, with URL lookahead so `--folder URL` works cleanly).
- Add `batch` command for pasting multi-line links/share text, positional URLs, `--list`, or piped stdin.
- Add `retry` command that remembers and retries the latest `export-report.json` with zero arguments (or an explicit path).
- Add `config` command to view, set, or reset the persistent default output folder in `~/.feishu-grab.json` without affecting saved search tenant state.
- Add `search`, finding documents and wiki knowledge bases through the signed-in session; chat messages are never searched.
- Add `feishu-grab-mcp`, a stdio MCP server exposing `feishu_search`, `feishu_read`, and `feishu_export` to any agent harness.
- Run searches and background `feishu_read` through BrowserOS neo when available, keeping everyday Chrome untouched.
- Consolidate Homebrew distribution into `Popcornnnnnnnn/homebrew-tap` (`brew install Popcornnnnnnnn/tap/feishu-grab`) and publish repository publicly.

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
