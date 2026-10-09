# Changelog

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
