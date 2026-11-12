import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateIntegrity } from '../lib/integrity.mjs';

function fullEvidence(overrides = {}) {
  return {
    route: 'ssr',
    bodyPresent: true,
    pagination: 'complete',
    media: {
      images: { expected: 2, exported: 2 },
      attachments: { expected: 1, exported: 1 },
      whiteboards: { expected: 0, exported: 0 },
      structuredSheets: { expected: 0, exported: 0, formulaExpressionsMissing: 0 },
      sheetFallbacks: { expected: 0, exported: 0 },
    },
    comments: { status: 'checked', threads: 1 },
    renderability: { status: 'checked', markdownImagesInHtmlTables: 0 },
    unknownBlocks: 0,
    ...overrides,
  };
}

test('complete requires positive evidence for every dimension', () => {
  assert.equal(evaluateIntegrity(fullEvidence()).verdict, 'complete');
});

test('known truncation is incomplete', () => {
  const report = evaluateIntegrity(fullEvidence({ pagination: 'truncated' }));
  assert.equal(report.verdict, 'incomplete');
  assert.equal(report.checks.find((check) => check.name === 'pagination').status, 'fail');
});

test('a missing resource is incomplete', () => {
  const evidence = fullEvidence();
  evidence.media.images.exported = 1;
  assert.equal(evaluateIntegrity(evidence).verdict, 'incomplete');
});

test('unprovable pagination or comments produce degraded output', () => {
  const report = evaluateIntegrity(fullEvidence({
    pagination: 'unknown',
    comments: { status: 'failed', error: 'request failed' },
  }));
  assert.equal(report.verdict, 'degraded');
});

test('a complete visual sheet fallback remains degraded', () => {
  const evidence = fullEvidence();
  evidence.media.sheetFallbacks = { expected: 1, exported: 1 };
  const report = evaluateIntegrity(evidence);
  assert.equal(report.verdict, 'degraded');
  assert.equal(report.checks.find((check) => check.name === 'sheetFallbacks').status, 'warn');
});

test('a complete whiteboard screenshot set is a normal pass', () => {
  const evidence = fullEvidence();
  evidence.media.whiteboards = { expected: 1, exported: 1 };
  const report = evaluateIntegrity(evidence);
  assert.equal(report.verdict, 'complete');
  assert.equal(report.checks.find((check) => check.name === 'whiteboards').status, 'pass');
});

test('structured sheets degrade when formula expressions are unavailable', () => {
  const evidence = fullEvidence();
  evidence.media.structuredSheets = { expected: 1, exported: 1, formulaExpressionsMissing: 1 };
  const report = evaluateIntegrity(evidence);
  assert.equal(report.verdict, 'degraded');
  assert.equal(report.checks.find((check) => check.name === 'structuredSheets').status, 'warn');
});

test('fully structured sheets with formula expressions can be complete', () => {
  const evidence = fullEvidence();
  evidence.media.structuredSheets = { expected: 1, exported: 1, formulaExpressionsMissing: 0 };
  const report = evaluateIntegrity(evidence);
  assert.equal(report.verdict, 'complete');
  assert.equal(report.checks.find((check) => check.name === 'structuredSheets').status, 'pass');
});

test('Markdown images left inside HTML tables are incomplete', () => {
  const report = evaluateIntegrity(fullEvidence({
    renderability: { status: 'checked', markdownImagesInHtmlTables: 2 },
  }));
  assert.equal(report.verdict, 'incomplete');
  assert.equal(report.checks.find((check) => check.name === 'renderability').status, 'fail');
});
