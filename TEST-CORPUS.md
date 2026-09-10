# Feishu Export Test Corpus

The corpus is tracked in [`tests/corpus/manifest.json`](tests/corpus/manifest.json). A case is covered only when its `state` is `live`, its remote document exists in the isolated free Feishu tenant, and its latest export passes `tools/validate-corpus.mjs`.

Local source files, generators, or setup notes do **not** count as live coverage.

| Case | Scope | Current state | Foreground needed |
| --- | --- | --- | --- |
| FG-01 | Basic rich text | `live` | No |
| FG-02 | Native and merged tables | `live` | No |
| FG-03 | Structured Markdown import | `live` | No |
| FG-04 | Long document and pagination | `live` | No |
| FG-05 | Images | `local_assets_ready` | Yes |
| FG-06 | Attachments | `local_assets_ready` | Yes |
| FG-07 | Native whole-document comments | `live` | No |
| FG-08 | Embedded sheet | `blocked_by_native_editor` | Yes |
| FG-09 | Whiteboard | `blocked_by_native_editor` | Yes |
| FG-10 | Complex layout | `blocked_by_native_editor` | Yes |

## Acceptance

1. Create the case in the isolated free tenant and record its URL only under ignored `tests/private/` data.
2. Export the document into an ignored output directory.
3. Run `node tools/validate-corpus.mjs <case-id> <export-dir>`.
4. Change `state` to `live` only after validation passes against the real remote document.

The committed manifest contains no tenant URL, cookie, token, exported private content, or user identity.

Generate the ignored image and attachment payloads with:

```bash
node tools/generate-corpus-assets.mjs
```

Markdown and DOCX cases can be imported through the hidden test Chrome target without taking window focus:

```bash
AI_CHROME_PORT=9223 node tools/import-markdown-background.mjs <drive-home-url> <markdown-or-docx-file>
```

FG-07 currently proves multiple native whole-document comments, including Unicode comment text. Feishu DOCX import does not preserve Word comments, so the three native comments are added after import in the isolated tenant. Anchored text comments, reply threads, and resolved comments remain explicit gaps; they are not counted as covered.
