# Feishu Grabber — Chrome extension preview

Export the current Feishu/Lark document as a ZIP or folder containing Markdown, images,
attachments, structured sheet sidecars, and an integrity report. Processing stays
in your browser; document content and sign-in credentials are not sent to a
third-party service.

## Install locally

1. Open `chrome://extensions` in the Chrome profile where you use Feishu.
2. Enable **Developer mode**, click **Load unpacked**, and select the built
   **Feishu Grabber Extension** folder (the folder containing `manifest.json`).
3. Open a Feishu or Lark document, then click **Feishu Grabber** in Chrome's
   Extensions menu. Select **Export** in the small toolbar popup. The current document is detected
   automatically. The icon is disabled on unrelated pages; no new tab is opened.

You can close the popup after starting an export. It continues in a hidden
background document and saves the chosen output automatically. Reopen the popup to
see progress, cancel, or download the result again. Keep Chrome and the source
document open. The ZIP goes to Chrome's configured download location. Extract the whole ZIP to preserve local
image and attachment links. **Export again** reruns the document; **Download ZIP
again** saves the already-generated archive without fetching it again.

## Settings

Open the gear button in the popup. Settings are saved locally in this Chrome
profile and apply to the next export; running tasks keep their original choices.

- **Export format:** ZIP archive (default) or Folder. Folder mode saves separate
  files inside a new document folder, preserving relative image/attachment links.
  Each export and **Save folder again** uses a new directory to avoid overwriting
  prior exports. Each file appears in Chrome's download history.
- **Download subfolder:** a relative path inside Chrome's configured download
  location, such as `Feishu Exports` or `Work/Docs`. Empty means the root. Absolute
  paths and `..` are rejected. **Change Chrome download location** opens Chrome's
  own settings; changing that base location affects other Chrome downloads too.
- **Ask where to save each ZIP:** enables Chrome's save dialog for ZIP output.
  It does not apply to Folder mode, which saves the whole bundle automatically.
- **Appearance:** Follow system (default), Light, or Dark.

If a folder save is cancelled or interrupted, already-saved files are kept and
reported. **Save folder again** writes a fresh folder from the retained result.
Chrome and the source document must remain open during an export.

## Preview scope

- One current document at a time; SSR block data with pagination, native tables,
  images, native file attachments, comments, embedded structured sheets,
  whiteboards captured as page screenshots (Chrome Debugger element capture,
  visible-tab crop as fallback; failures are reported, never silent), and
  Bitable wiki nodes exported as one CSV per data table.
- 100 MB of uncompressed files per export. Oversized or unavailable resources
  are reported as missing; they never silently count as complete.
- Whiteboard structured shapes, DOM-only documents, PDF, knowledge-base traversal,
  persistent queues and resume-after-browser-close are not included yet.
- `complete` means all checked dimensions passed. `degraded` means a dimension
  could not be verified. `incomplete` means content is known to be missing.
- A downloaded ZIP is not proof of content completeness: read the result checks.

## Permissions and data

`storage` retains only export preferences and appearance locally.
`activeTab` identifies the document you selected. `scripting` reads document data
through that tab and locates whiteboard blocks. Host access is limited to Feishu/Lark domains and is needed for
authenticated document/media requests. `downloads` saves the archive and reports
download completion. `offscreen` keeps ZIP generation and its download Blob
alive after the popup closes, without opening a window. `debugger` is used only
to capture embedded whiteboards as PNG screenshots inside the document tab; the
attachment banner appears briefly per board and no debugging session is opened
against any other site. No `cookies`, browsing-history, or broad all-sites
permission is requested. The extension does not store login credentials or send
analytics. Only the latest export is retained in memory until a new export
replaces it, Chrome exits, or the extension reloads. Saved archives remain in
your downloads until you remove them.

## Development

Run `npm run build:extension` from the repository root. The result is
`dist/Feishu Grabber Extension/`, with a distributable development ZIP alongside
it. All executable dependencies are bundled locally; no remote code is loaded.
This is an unpacked preview, not a Chrome Web Store publication.
