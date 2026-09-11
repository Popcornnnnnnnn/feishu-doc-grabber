#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

const [caseId, exportDirArg] = process.argv.slice(2);
if (!caseId || !exportDirArg) {
  console.error('Usage: node tools/validate-corpus.mjs <case-id> <export-dir>');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'tests/corpus/manifest.json'), 'utf8'));
const fixture = manifest.cases.find((item) => item.id === caseId);
if (!fixture) {
  console.error(`Unknown corpus case: ${caseId}`);
  process.exit(1);
}

const exportDir = resolve(exportDirArg);
const report = JSON.parse(readFileSync(join(exportDir, 'export-report.json'), 'utf8'));
if (report.documents.length !== 1) {
  console.error(`Expected exactly one exported document, found ${report.documents.length}.`);
  process.exit(1);
}

const document = report.documents[0];
const markdownFiles = readdirSync(exportDir).filter((name) => name.endsWith('.md'));
if (markdownFiles.length !== 1) {
  console.error(`Expected exactly one Markdown file, found ${markdownFiles.length}.`);
  process.exit(1);
}
const markdownPath = join(exportDir, markdownFiles[0]);
const markdown = readFileSync(markdownPath, 'utf8');
const expected = fixture.expect;
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

check(document.operationalStatus === 'success', `operationalStatus is ${document.operationalStatus}`);
check(document.integrity?.verdict === expected.integrity,
  `integrity verdict is ${document.integrity?.verdict}, expected ${expected.integrity}`);
check(Buffer.byteLength(markdown) >= expected.minMarkdownBytes,
  `Markdown is ${Buffer.byteLength(markdown)} bytes, expected at least ${expected.minMarkdownBytes}`);

for (const sentinel of expected.sentinels || []) {
  check(markdown.includes(sentinel), `missing sentinel: ${sentinel}`);
}
for (const sentinel of expected.commentSentinels || []) {
  check(markdown.includes(sentinel), `missing comment sentinel: ${sentinel}`);
}

const evidence = document.integrity?.evidence || {};
if (expected.minBlocks != null) {
  check(Number(evidence.blocks || 0) >= expected.minBlocks,
    `block count is ${evidence.blocks || 0}, expected at least ${expected.minBlocks}`);
}
for (const type of expected.requiredBlockTypes || []) {
  check(Number(evidence.blockTypes?.[type] || 0) > 0, `missing block type: ${type}`);
}
if (expected.minCommentThreads != null) {
  check(Number(evidence.comments?.threads || 0) >= expected.minCommentThreads,
    `comment threads are ${evidence.comments?.threads || 0}, expected at least ${expected.minCommentThreads}`);
}
for (const [kind, count] of Object.entries(expected.media || {})) {
  check(Number(evidence.media?.[kind]?.expected || 0) === count,
    `${kind} detected count is ${evidence.media?.[kind]?.expected || 0}, expected ${count}`);
  check(Number(evidence.media?.[kind]?.exported || 0) === count,
    `${kind} exported count is ${evidence.media?.[kind]?.exported || 0}, expected ${count}`);
}
if (expected.structuredSheet) {
  try {
    const sidecar = JSON.parse(readFileSync(join(exportDir, 'assets', expected.structuredSheet.asset), 'utf8'));
    check(sidecar.structuredComplete === true, 'structured Sheet sidecar is not complete');
    check((sidecar.missingBlocks || []).length === 0, 'structured Sheet has missing blocks');
    check((sidecar.unknownCellTypes || []).length === 0, 'structured Sheet has unknown cell types');
    check(Number(sidecar.missingFormulaValues || 0) === 0, 'structured Sheet has missing formula values');
    check(Number(sidecar.formulaExpressionsMissing || 0) === Number(expected.structuredSheet.formulaExpressionsMissing || 0),
      `formulaExpressionsMissing is ${sidecar.formulaExpressionsMissing || 0}, expected ${expected.structuredSheet.formulaExpressionsMissing || 0}`);
    if (expected.structuredSheet.minMergedRanges != null) {
      check((sidecar.merges || []).length >= expected.structuredSheet.minMergedRanges,
        `merged Sheet ranges are ${(sidecar.merges || []).length}, expected at least ${expected.structuredSheet.minMergedRanges}`);
    }
    const values = Object.fromEntries((sidecar.cells || []).map((cell) => [cell.address, cell.value]));
    for (const [address, value] of Object.entries(expected.structuredSheet.cells || {})) {
      check(values[address] === value, `Sheet cell ${address} is ${JSON.stringify(values[address])}, expected ${JSON.stringify(value)}`);
    }
    const formulas = Object.fromEntries((sidecar.cells || []).map((cell) => [cell.address, cell.formula]));
    for (const [address, formula] of Object.entries(expected.structuredSheet.formulas || {})) {
      check(formulas[address] === formula,
        `Sheet formula ${address} is ${JSON.stringify(formulas[address])}, expected ${JSON.stringify(formula)}`);
    }
  } catch (error) {
    failures.push(`structured Sheet sidecar is unavailable: ${error.message}`);
  }
}
if (expected.assetSha256) {
  const assetsDir = join(exportDir, 'assets');
  let actual = [];
  try {
    actual = readdirSync(assetsDir).map((name) => sha256(join(assetsDir, name))).sort();
  } catch {
    failures.push('assets directory is missing');
  }
  check(JSON.stringify(actual) === JSON.stringify([...expected.assetSha256].sort()),
    `asset SHA-256 multiset does not match (${actual.length}/${expected.assetSha256.length})`);
}
for (const [name, hash] of Object.entries(expected.attachmentSha256 || {})) {
  const path = join(exportDir, name);
  try {
    check(sha256(path) === hash, `attachment SHA-256 mismatch: ${name}`);
  } catch {
    failures.push(`attachment is missing: ${name}`);
  }
}

if (failures.length) {
  console.error(`FAIL ${fixture.id} ${fixture.title}`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`PASS ${fixture.id} ${fixture.title}`);
console.log(`- ${basename(markdownPath)}`);
console.log(`- ${document.integrity.verdict}; ${evidence.blocks || 'unknown'} blocks`);
