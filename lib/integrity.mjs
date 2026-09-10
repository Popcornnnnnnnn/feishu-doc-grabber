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
    ['whiteboards', 'whiteboards'],
    ['sheetFallbacks', 'sheet fallbacks'],
  ]) {
    const item = evidence.media?.[name] ?? { expected: 0, exported: 0 };
    const expected = Number(item.expected || 0);
    const exported = Number(item.exported || 0);
    add(name, exported === expected ? 'pass' : 'fail', `${exported}/${expected} ${label} exported.`);
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

