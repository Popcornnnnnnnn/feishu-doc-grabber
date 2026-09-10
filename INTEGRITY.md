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
| Whiteboards and sheet fallbacks | Screenshot count equals detected fallback count | Skipped or failed screenshot is incomplete |
| Comments | Comment endpoints were checked successfully | Unavailable or failed check is degraded |
| Block recognition | No unknown DOM block signatures | Unknown signatures are degraded |

## Background behavior

The default mode never brings Chrome to the foreground. Canvas-only whiteboards and sheet fallbacks are therefore skipped and reported as `incomplete`. `--allow-focus` explicitly permits the temporary foreground screenshot path.

## Process exit codes

- `0`: all documents are `complete`
- `1`: at least one export operation failed
- `2`: files were produced, but at least one verdict is `degraded` or `incomplete`

Operational success and content integrity remain separate fields in the report so callers cannot confuse “a file exists” with “the export is complete.”
