# Popup UI refinement — 2026-09-16

## Applied Mac UI System contracts

This is a use-only request. No central References or Experiences were created or
changed. The relevant contracts were:

- `content/experiences/clear-optional-settings/experience.md`: distinguish active
  preferences, unsaved drafts, and saved feedback; allow clearing the subfolder.
- `content/experiences/visible-hover-feedback/experience.md`: quiet, visible
  hover/pressed/focus/disabled states with no layout movement.
- `content/experiences/default-light-dark-appearance/experience.md`: persisted
  System/Light/Dark choices and equivalent hierarchy in both appearances.

## Observed issues and changes

- The settings form stacked large controls and long helper paragraphs. Related
  choices now share compact Export, Save location, and Appearance groups.
- Full-width primary buttons dominated a small utility popup. Primary actions
  now use compact trailing buttons; toolbar and document hierarchy are quieter.
- Clearing the optional destination required manual editing, and Save was always
  enabled. Added an accessible clear control, explicit unsaved/saved feedback,
  and disabled Save only for unchanged or invalid drafts.
- Hover feedback was a uniform brightness filter. Controls now use role-specific
  semantic hover, pressed, focus, selected, and disabled colors in both themes.
- Limits and secondary guidance occupied the main workflow. Core background-run
  guidance stays visible; detailed limitations use a disclosure control.

## Validation

- `npm run test:extension` passed with zero page errors in isolated headless
  Chrome for Testing. The daily Chrome window was not operated.
- Inspected the real 360 px popup, Light/Dark settings at 360 x 580, and the actual
  popup's scrolled footer. No horizontal overflow. Native popup screenshots use
  viewport captures because headless full-page capture can tile outside its
  actual surface; these capture artifacts were rejected.
- Verified visible primary-button hover in both appearances with unchanged
  bounds and reduced motion, plus keyboard focus on the format control.
- Cleared a previously saved subfolder, saved it, reloaded, and confirmed the
  default download location. Unchanged Save stayed disabled; invalid paths did
  not overwrite the saved preference.
- Background export, popup close/reopen, worker restart, ZIP/folder output,
  repeated folder saves, and file-only upgrades still passed.

Local evidence (ignored): `tests/private/extension-qa/results.json`,
`toolbar-popup-ready.png`, `popup-hover-light.png`, `popup-hover-dark.png`,
`settings-light.png`, `settings-dark.png`, and `popup-settings-footer-dark.png`.
