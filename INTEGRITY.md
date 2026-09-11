# Export Integrity Protocol v1

An export is not considered complete merely because a file was written. Every run writes `export-report.json` and assigns each document one verdict:

- `complete`: the body is non-empty, the source reports no remaining pages, every detected resource was exported, comments were checked, and no unknown block signature was observed.
- `degraded`: a file was produced, but at least one dimension could not be positively verified. DOM fallback is degraded because it cannot prove tail completeness.
- `incomplete`: content is known to be missing, including an unfetched source page or a detected resource that was not exported.

## Checked dimensions

| Check | Complete evidence | Degraded or incomplete evidence |
| --- | --- | --- |
| Body | Non-empty extracted body | Empty body is incomplete |
| Pagination | SSR explicitly reports `has_more = false` | Unknown is degraded; `has_more = true` is incomplete |
| Images and attachments | Exported count equals detected count | Any missing resource is incomplete |
| Structured sheets | Every declared cell/formula block is decoded; computed values, formula expressions, and declared merge mutations are exported | Missing blocks are incomplete; unavailable formula expressions are degraded even when computed values are preserved; corpus cases may require a minimum merge count to catch malformed fixtures |
| Whiteboards and sheet fallbacks | No visual fallback is required | A complete screenshot set is degraded because structured/offscreen completeness is unproven; a missing screenshot is incomplete |
| Comments | Comment endpoints were checked successfully | Unavailable or failed check is degraded |
| Block recognition | No unknown DOM block signatures | Unknown signatures are degraded |

## Background behavior

Markdown defaults to a zero-render path: document blocks, comments, media, and embedded sheets are read from authenticated SSR/API responses without creating a Chrome tab. If that evidence is unavailable, the run fails clearly instead of silently opening a renderer.

`--render-fallback` explicitly permits DOM and screenshot fallback. macOS may activate Chrome when a rendering target is created, even when CDP marks it as background. Successful screenshots remain `degraded` evidence rather than `complete`; missing screenshots are `incomplete`. `--allow-focus` is retained as a compatibility alias.

## Process exit codes

- `0`: all documents are `complete`
- `1`: at least one export operation failed
- `2`: files were produced, but at least one verdict is `degraded` or `incomplete`

Operational success and content integrity remain separate fields in the report so callers cannot confuse “a file exists” with “the export is complete.”
