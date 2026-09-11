const VALID_VERDICTS = new Set(['complete', 'degraded', 'incomplete']);

/**
 * Turn observable export evidence into a stable, machine-readable verdict.
 * "complete" is intentionally strict: every required dimension must be
 * positively verified, not merely free of a known error.
 */
export function evaluateIntegrity(evidence) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  add('body', evidence.bodyPresent ? 'pass' : 'fail',
    evidence.bodyPresent ? 'Exported body is non-empty.' : 'Exported body is empty or unavailable.');

  if (evidence.pagination === 'complete') {
    add('pagination', 'pass', 'Source reports no remaining pages.');
  } else if (evidence.pagination === 'truncated') {
    add('pagination', 'fail', 'Source reports more pages that were not fetched.');
  } else {
    add('pagination', 'warn', 'This extraction route cannot prove tail completeness.');
  }

  for (const [name, label] of [
    ['images', 'images'],
    ['attachments', 'attachments'],
  ]) {
    const item = evidence.media?.[name] ?? { expected: 0, exported: 0 };
    const expected = Number(item.expected || 0);
    const exported = Number(item.exported || 0);
    add(name, exported === expected ? 'pass' : 'fail', `${exported}/${expected} ${label} exported.`);
  }

  const whiteboards = evidence.media?.whiteboards ?? { expected: 0, exported: 0 };
  const expectedWhiteboards = Number(whiteboards.expected || 0);
  const exportedWhiteboards = Number(whiteboards.exported || 0);
  if (exportedWhiteboards !== expectedWhiteboards) {
    add('whiteboards', 'fail', `${exportedWhiteboards}/${expectedWhiteboards} whiteboards exported.`);
  } else if (expectedWhiteboards > 0) {
    add('whiteboards', 'warn', `${exportedWhiteboards}/${expectedWhiteboards} visual whiteboard fallbacks exported; structured completeness is not proven.`);
  } else {
    add('whiteboards', 'pass', '0/0 whiteboards exported.');
  }

  const sheets = evidence.media?.sheetFallbacks ?? { expected: 0, exported: 0 };
  const expectedSheets = Number(sheets.expected || 0);
  const exportedSheets = Number(sheets.exported || 0);
  if (exportedSheets !== expectedSheets) {
    add('sheetFallbacks', 'fail', `${exportedSheets}/${expectedSheets} sheet fallbacks exported.`);
  } else if (expectedSheets > 0) {
    add('sheetFallbacks', 'warn', `${exportedSheets}/${expectedSheets} visual sheet fallbacks exported; structured completeness is not proven.`);
  } else {
    add('sheetFallbacks', 'pass', '0/0 sheet fallbacks exported.');
  }

  const comments = evidence.comments?.status ?? 'unknown';
  if (comments === 'checked' || comments === 'not_applicable') {
    add('comments', 'pass', comments === 'checked'
      ? `${Number(evidence.comments?.threads || 0)} comment threads checked.`
      : 'Comments are not part of this output format.');
  } else {
    add('comments', 'warn', evidence.comments?.error || 'Comment completeness was not verified.');
  }

  const unknownBlocks = Number(evidence.unknownBlocks || 0);
  add('block_recognition', unknownBlocks ? 'warn' : 'pass',
    unknownBlocks ? `${unknownBlocks} unrecognized block signatures found.` : 'No unrecognized block signatures found.');

  const verdict = checks.some((check) => check.status === 'fail')
    ? 'incomplete'
    : checks.some((check) => check.status === 'warn') ? 'degraded' : 'complete';
  if (!VALID_VERDICTS.has(verdict)) throw new Error(`Invalid integrity verdict: ${verdict}`);

  return {
    schemaVersion: 1,
    verdict,
    route: evidence.route,
    checks,
    evidence,
  };
}
