// Replay previously captured test-tenant response bodies in the real extension
// runtime. This proves decoder compatibility, not live-account authentication.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const [longDirectory, sheetDirectory] = process.argv.slice(2);
if (!longDirectory || !sheetDirectory) throw new Error('Usage: node tools/verify-extension-recordings.mjs <FG-04 capture directory> <FG-08 capture directory>');
async function responses(directory, pathname) {
  const rows = (await readFile(resolve(directory, 'index.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  return Promise.all(rows.filter((row) => new URL(row.url).pathname === pathname)
    .map(async (row) => JSON.parse(await readFile(resolve(directory, row.file), 'utf8'))));
}
const pages = (await responses(longDirectory, '/space/api/docx/pages/client_vars')).map((item) => item.data);
const [sheet] = await responses(sheetDirectory, '/space/api/v3/sheet/client_vars');
const formulas = await responses(sheetDirectory, '/space/api/v3/sheet/formula/data_block');
assert.ok(pages.length > 1 && sheet && formulas.length);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', headless: true, pipe: true, enableExtensions: true });
try {
  const extensionId = await browser.installExtension(resolve('dist/Feishu Grabber Extension'));
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/extension/task.html`);
  const result = await page.evaluate(async ({ pages, sheet, formulas }) => {
    const { mergeClientVarsPages, clientVarsDataToMarkdown } = await import('../lib/ssr.mjs');
    const { decodeSheetClientVars } = await import('../lib/sheet.mjs');
    // Captures contain pagination responses, not the first HTML response. Supply
    // only a root for decoding; do not claim a complete document export.
    const id = pages[0].id;
    const initial = { id, has_more: true, block_map: { [id]: { id, data: { type: 'page', children: [] } } } };
    const merged = mergeClientVarsPages(initial, pages);
    const parsed = clientVarsDataToMarkdown(merged);
    const expectedIds = new Set(pages.flatMap((item) => Object.keys(item.block_map)));
    const decoded = decodeSheetClientVars(sheet, formulas);
    return {
      recordedPages: pages.length,
      recordedBlocks: expectedIds.size,
      allRecordedBlocksRetained: [...expectedIds].every((id) => Boolean(merged.block_map[id])),
      middleSentinelRetained: parsed.markdown.includes('LONG-BLOCK-0120'),
      tailSentinelRetained: parsed.markdown.includes('LONG-END-0240'),
      sheetComplete: decoded.structuredComplete,
      formula: decoded.cells.find((cell) => cell.address === 'D2')?.formula,
      formulaValue: decoded.cells.find((cell) => cell.address === 'D2')?.value,
      offscreenTail: decoded.cells.find((cell) => cell.address === 'L12')?.value,
    };
  }, { pages, sheet, formulas });
  assert.ok(result.allRecordedBlocksRetained && result.middleSentinelRetained && result.tailSentinelRetained);
  assert.equal(result.sheetComplete, true);
  assert.equal(result.formula, '=SUM(C2:C4)');
  assert.equal(result.formulaValue, 10);
  assert.equal(result.offscreenTail, 'SHEET-TAIL-L12-377');
  const evidence = { generatedAt: new Date().toISOString(), mode: 'recorded-test-tenant-responses-in-headless-extension', liveAccountTested: false, completeDocumentExportTested: false, result };
  const directory = resolve('tests/private/extension-qa');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'recording-results.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await browser.close(); }
