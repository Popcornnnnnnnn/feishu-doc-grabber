# Feishu Export Test Corpus

The corpus is tracked in [`tests/corpus/manifest.json`](tests/corpus/manifest.json). A case is covered only when its `state` is `live`, its remote document exists in the isolated free Feishu tenant, and its latest export passes `tools/validate-corpus.mjs`.

Local source files, generators, or setup notes do **not** count as live coverage.

| Case | Scope | Current state | Foreground needed |
| --- | --- | --- | --- |
| FG-01 | Basic rich text | `live` | No |
| FG-02 | Native and merged tables | `live` | No |
| FG-03 | Structured Markdown import | `live` | No |
| FG-04 | Long document and pagination | `live` | No |
| FG-05 | Images with byte-fidelity checks | `live` | No |
| FG-06 | Native attachments with byte-fidelity checks | `live` | No |
| FG-07 | Native whole-document comments | `live` | No |
| FG-08 | Embedded sheet, formula, Unicode, wide/offscreen cells | `live_fixture_incomplete` | No |
| FG-09 | Whiteboard with three shapes, two connectors, labels, Unicode text | `live` (`degraded`) | No |
| FG-10 | Callout, checked/unchecked Todo, columns, quote container | `live` | No |

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

Native fixture mutations use the same hidden target and require an exact tenant guard:

```bash
TEST_TENANT_HOST=<free-test-tenant> AI_CHROME_PORT=9223 node tools/insert-block-background.mjs <doc-url> <anchor-text> <slash-command>
TEST_TENANT_HOST=<free-test-tenant> AI_CHROME_PORT=9223 node tools/set-sheet-cell-background.mjs <doc-url> <cell> <value>
TEST_TENANT_HOST=<free-test-tenant> AI_CHROME_PORT=9223 node tools/whiteboard-action-background.mjs <doc-url> <shape|connector|text> ...
```

The mutation scripts submit editor actions; the case is not accepted until a fresh export passes `tools/validate-corpus.mjs`. This keeps editor automation evidence separate from exporter evidence.

FG-07 currently proves multiple native whole-document comments, including Unicode comment text. Feishu DOCX import does not preserve Word comments, so the three native comments are added after import in the isolated tenant. Anchored text comments, reply threads, and resolved comments remain explicit gaps; they are not counted as covered.

FG-05 verifies five exported image payloads by SHA-256, including a duplicate, a large PNG, a JPEG, and an SVG source imported through a deterministic PNG raster fallback. Native SVG upload remains an explicit gap.

FG-06 uses native Feishu file blocks created through the hidden AI Chrome target. TXT, PDF, ZIP, Unicode filename, and no-extension payloads are each checked by filename and SHA-256 after export.

FG-08 exports the declared Sheet cell blocks as a coordinate-preserving HTML table plus JSON sidecar, including the offscreen L12 tail, D2's computed value, and its `=SUM(C2:C4)` expression. The exporter also decodes merge mutations into `rowspan`/`colspan`. The current live fixture is intentionally marked `live_fixture_incomplete`: its saved resource snapshot contains the `MERGE-E10-F11` text but no actual merge mutation, so corpus validation now fails until the isolated test sheet is repaired and freshly exported. FG-09 intentionally remains `degraded`: it is a visual fallback and still lacks structured whiteboard export.

FG-10 proves the native block types currently supported by the SSR parser. A true nested quote, user mention, and bookmark card remain explicit gaps and are not counted as covered.
