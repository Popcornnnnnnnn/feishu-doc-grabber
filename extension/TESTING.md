# Extension preview validation — 2026-09-16

## Verified locally

- `npm test`: 45 passed, 0 failed; the existing interactive PDF/browser smoke
  test was intentionally skipped to avoid foreground interaction.
- `npm run test:extension`: built and installed the actual Manifest V3 extension
  in headless Chrome for Testing 153.0.8010.36, using a temporary profile and
  synthetic Feishu network responses. No existing browser was restarted.
- End-to-end checks: source-tab identification, isolated-world document requests,
  synthetic CSRF handling, pagination tail, anchored comment and reply,
  cross-origin image/attachment retrieval, ZIP packaging in a module worker,
  completed Chrome download, and byte-for-byte extracted asset checks.
- Missing image: `incomplete`; unavailable comments: `degraded`; cancellation:
  no download; re-export after cancellation: successful; closed source tab:
  disabled export with source-selection guidance and no old success result.
- Reproduced and fixed a false-complete result when Feishu's block tree refers
  to a section that was not returned. Child, table-cell, and sequence references
  are now checked; missing sections make the export `incomplete`.
- Existing compressed Sheet sample decoded in the extension runtime with its
  formula expression, computed value, and offscreen L12 tail preserved.
- Saved real test-tenant responses replayed in the extension runtime: all 725
  blocks from four captured pagination responses were retained, including the
  middle and final sentinels. The saved Sheet response retained its `D2` formula,
  computed value, and `L12` tail. These recordings omit the initial document HTML
  and therefore do not establish a complete live-document export.
- Screenshots inspected in light/dark mode; 390-pixel layout checked for
  horizontal overflow.
- `npm audit`: no reported vulnerabilities after adding fflate 0.8.3.
- `git diff --check`: passed.

Local detailed evidence and screenshots: `tests/private/extension-qa/` (ignored).

## Background-only workflow

Run `npm run test:extension`. It launches only Chrome for Testing in headless
mode, with a fresh temporary profile and a private pipe connection. It neither
connects to the user's running Chrome nor reuses its profile. If Chrome for
Testing is unavailable, the command fails; there is no visible-browser fallback.

The suite opens the actual toolbar popup using `chrome.action.openPopup()` inside
that headless browser, clicks **Export**, verifies the downloaded ZIP, and saves
popup screenshots. It also checks the active-document detection and disabled
action on unrelated pages. Tab activation in this test changes only the headless
browser's internal active tab; it does not activate a desktop application.

Do not use native UI clicking, AppleScript activation, or the interactive
`test:browser` command for this workflow. Installing/reloading in daily Chrome
is outside this background suite; do not silently fall back to foreground UI.

## Earlier live verification in the user's Chrome Default profile (0.1.0)

- Installed and pinned Feishu Grabber 0.1.0, extension ID
  `oemfoegidblnmohalpgjnffjjpokhkcp`, from
  `~/Applications/FeishuGrabberExtension-0.1.0/`.
- Final entry point is a 360 px toolbar popup, with automatic active-document
  detection and an **Export** button. It opens no task tab or side panel.
- Live Feishu wiki document export completed through that popup with the existing
  sign-in: 1,302 blocks, 69 table rows, 16/16 images and 19 archive entries.
  The downloaded ZIP was read back; all images are nonempty and the final table
  sentinel is present. Integrity verdict: `complete`.
- On the unrelated `chrome://extensions/` page the action is disabled and no
  export popup opens. The isolated runtime suite also verifies both the active
  document detection and action enable/disable state.
- Version 0.1.0 required the popup to stay open. Version 0.1.1 replaces that
  execution path with a hidden offscreen document; see the new checks below.

Local evidence: `tests/private/extension-qa/live-default-profile.json`.
The exported test archive is in the user's Chrome download folder. No document
content was uploaded to a third-party service.

## Not yet verified

This live test establishes the tested Feishu tenant and document, not every tenant
or Lark compatibility. Real comments, native attachments and structured Sheets
remain covered by fixture/recording tests rather than a fresh live test.

Chrome Web Store review/publication, Windows runtime verification, knowledge-base
traversal, PDF, whiteboard structured export (screenshots are captured since 0.2.0),
and persistent task recovery are outside this first preview.

## Background export fix (0.1.1)

- Export and ZIP generation run in an offscreen document. The popup only sends
  commands and displays the latest job state. Closing it sends no cancellation.
- The real toolbar popup was closed during an intentionally delayed export.
  Reopening restored progress; a second start was rejected. Closing again still
  produced a complete downloaded ZIP with the paginated tail and exact image bytes.
- The extension service worker was explicitly stopped after completion. Reopening
  the popup restarted it and restored the result from the offscreen document.
- The hidden worker does not create a browser tab or a focusable window.
- Existing cancellation, missing-image, failed-comment, missing-block, sheet
  decoding, retry and closed-source checks remain in the headless suite.
- The file-only upgrade from 0.1.0 to 0.1.1 was verified in the isolated
  profile with Developer mode enabled: the next popup reloads the manifest,
  registers the offscreen permission, and the following open uses 0.1.1.
- Only the latest job/archive is retained in memory. Closing Chrome or reloading
  the extension ends the job; resuming after browser exit is not implemented.
- This version was validated in isolated headless Chrome, not by operating the
  user's Chrome UI. The installed folder can be updated on disk without focus
  changes. Its next user-opened popup reloads a still-running 0.1.0 manifest;
  clicking the icon again then opens 0.1.1.

## Settings and folder output (0.1.2)

- Settings were changed through the UI, saved, and read back after popup-code
  reload. Invalid parent paths were rejected without altering saved preferences.
- Explicit Light and Dark overrides were checked against the opposite simulated
  OS appearance; Follow system responded to the OS theme. Rendered settings
  screenshots were inspected in both themes.
- Folder mode completed after the real toolbar popup was closed. Downloaded
  Markdown, image and attachment bytes were verified at their actual relative
  paths under a custom `QA/Exports` directory. Re-saving produced a new directory.
- ZIP mode also saved to the configured subfolder, and the ZIP contents passed
  the existing regression checks. ZIP save-dialog UI is not exercised by the
  headless suite; the option uses Chrome's `saveAs` download parameter.
- The isolated profile uses a real download-location preference rather than the
  CDP download override, which discards suggested directory structure. No daily
  Chrome preferences were changed.
- The 0.1.0-to-0.1.2 self-reload upgrade was verified with the new `storage` and
  `offscreen` permissions registered. Updated files are copied to the existing
  installed folder; the next user-opened popup activates the new manifest.

## Compact utility UI (0.1.3)

The popup and settings were refined using the explicitly invoked Mac UI System.
See `extension/design-qa.md` for the applied contracts and rendered checks. The
headless suite now verifies Light/Dark hover without layout movement, keyboard
focus, persisted clearing of the optional destination, and unchanged Save state.
The existing background-export and ZIP/folder regressions continue to pass.


## Current document tracking (0.1.4)

- Current document always comes from the current source tab. The most recent
  export snapshot no longer overrides that title or supplies another document's
  success report. A different completed job appears under Previous export with
  its own download control; a different running job is explicitly identified.
- Source URL/title changes, same-tab SPA navigation, active-tab changes, reloads,
  and source closure update the popup. Export refreshes the source before sending
  a request; the background service still verifies the URL before starting.
- `npm run test:extension` passed in isolated headless Chrome with zero page
  errors. Added navigation/reload/reopen checks, verified the next export's URL
  and document title, retained the previous ZIP download, and cancelled a job
  after switching documents without changing that job's source.
- Inspected `tests/private/extension-qa/popup-document-switched.png`, captured
  from the actual toolbar popup. Background lifecycle, ZIP/folder output,
  settings, and file-only upgrade regressions also passed.
- These checks use synthetic documents. The user's Chrome window was not
  operated; installing new files on disk takes effect through the next
  user-opened popup's manifest reload.


## Document-scoped toolbar badges (0.1.5) — 2026-09-17

- Removed the global export badge. Each badge now requires both the source tab
  ID and its current document URL to match the retained export job. Navigation
  updates clear unrelated badges; late export messages re-read the tab before
  updating it. Starting another job also clears the previous source tab's badge.
- Service-worker startup clears the legacy global badge and restores eligible
  tab badges from the existing offscreen snapshot without creating a new worker.
- `npm run test:extension` passed with zero page errors in isolated headless
  Chrome for Testing. Badge API readbacks confirmed an empty global badge and
  unmarked unrelated tabs, same-tab SPA navigation clearing the badge, completion
  after navigation leaving the unrelated page unmarked, and worker recovery
  respecting the current page. Returning to or refreshing the source restored
  its successful result. Running and incomplete/degraded badges also passed.
- The full existing popup, settings, background export, ZIP/folder output, and
  file-only upgrade suite passed. No daily Chrome window or profile was operated.
