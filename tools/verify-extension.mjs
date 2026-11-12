// Real extension runtime, synthetic Feishu responses, no user profile or focus changes.
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, cp, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { sourceURL, responseFor, imageBytes, attachmentBytes } from '../tests/fixtures/extension-data.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'tests/private/extension-qa');
await mkdir(output, { recursive: true });
const profileDirectory = await mkdtemp(resolve(tmpdir(), 'feishu-extension-profile-'));
await mkdir(resolve(profileDirectory, 'Default'), { recursive: true });
// CDP's download override discards extension-suggested subdirectories. Use a
// download preference in this new, disposable profile to exercise real paths.
await writeFile(resolve(profileDirectory, 'Default/Preferences'), JSON.stringify({ download: { default_directory: output, prompt_for_download: false } }));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', headless: true, pipe: true, enableExtensions: true, userDataDir: profileDirectory, defaultViewport: { width: 1100, height: 900 } });
const results = [];
const errors = [];
let scenario = 'complete';
let delayed = false;
let csrfChecked = 0;
const sessions = [];
let upgradeDirectory;
const offscreenAttachments = new Map();
async function attachOffscreen(target) {
  if (!target.url().endsWith('/extension/offscreen.html') || offscreenAttachments.has(target)) return;
  const attached = target.asPage().then(async (page) => { sessions.push(page); await intercept(page); return page; });
  offscreenAttachments.set(target, attached);
  await attached;
}
browser.on('targetcreated', (target) => { attachOffscreen(target).catch((error) => errors.push(error.message)); });
browser.on('targetchanged', (target) => { attachOffscreen(target).catch((error) => errors.push(error.message)); });
async function intercept(page) {
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    try {
      if (!request.url().startsWith('https://')) return await request.continue();
      if (new URL(request.url()).pathname === '/favicon.ico') return await request.respond({ status: 204 });
      if (new URL(request.url()).hostname === 'fixture.feishu.cn' || new URL(request.url()).hostname === 'internal-api-drive-stream.feishu.cn') {
        const fixture = responseFor(request.url(), { scenario });
        if (request.method() === 'POST') {
          assert.equal(request.headers()['x-csrftoken'], 'synthetic-test-token');
          csrfChecked++;
        }
        if (delayed && new URL(request.url()).pathname.startsWith('/docx/') && request.resourceType() !== 'document') {
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
        await request.respond({ status: fixture.status || 200, contentType: fixture.type || 'application/json', headers: { 'set-cookie': '_csrf_token=synthetic-test-token; Path=/; Secure; SameSite=Lax' }, body: typeof fixture.body === 'string' ? fixture.body : Buffer.from(fixture.body) });
      } else await request.abort();
    } catch (error) { errors.push(error.message); await request.abort().catch(() => {}); }
  });
}
try {
  const id = await browser.installExtension(resolve(root, 'dist/Feishu Grabber Extension'));
  const source = await browser.newPage();
  sessions.push(source);
  await intercept(source);
  await source.goto(sourceURL);
  const task = await browser.newPage();
  sessions.push(task);
  await intercept(task);
  await task.goto(`chrome-extension://${id}/extension/task.html`);
  const sourceId = await task.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, sourceURL);
  assert.ok(sourceId);
  async function expectBadge(tabId, text) {
    await task.waitForFunction(async (tabId, text) => (await chrome.action.getBadgeText({ tabId })) === text,
      { timeout: 10000 }, tabId, text);
  }
  const taskId = await task.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  assert.equal(await task.evaluate(() => chrome.action.getBadgeText({})), '');

  const actionState = await task.evaluate(async (id) => ({
    sourceEnabled: await chrome.action.isEnabled(id),
    unrelatedEnabled: await chrome.action.isEnabled((await chrome.tabs.getCurrent()).id),
  }), sourceId);
  assert.deepEqual(actionState, { sourceEnabled: true, unrelatedEnabled: false });
  await source.bringToFront();
  await task.reload();
  await task.waitForFunction(() => !document.getElementById('export').disabled, { timeout: 10000 });
  assert.equal(await task.$eval('#source', (element) => element.textContent), new URL(sourceURL).hostname);
  results.push({ scenario: 'toolbar-popup', activeDocumentDetected: true, unrelatedPageDisabled: true });
  await task.goto(`chrome-extension://${id}/extension/task.html#tab=${sourceId}`);
  await task.bringToFront();
  await task.reload();
  await task.waitForFunction(() => !document.getElementById('export').disabled, { timeout: 10000 });
  const sheetTests = await readFile(resolve(root, 'test/sheet.test.mjs'), 'utf8');
  const cellBlock = /const CELL_BLOCK = '([^']+)'/.exec(sheetTests)[1];
  const decoded = await task.evaluate(async (encoded) => {
    const { decodeCellBlock } = await import('../lib/sheet.mjs');
    const sheet = decodeCellBlock(encoded, { 1: { t: 2, v: 10 } });
    return { formula: sheet.cells.find((cell) => cell.address === 'D2'), tail: sheet.cells.find((cell) => cell.address === 'L12')?.value };
  }, cellBlock);
  assert.equal(decoded.formula.value, 10);
  assert.equal(decoded.formula.formula, '=SUM(C2:C4)');
  assert.equal(decoded.tail, 'SHEET-TAIL-L12-377');
  results.push({ scenario: 'browser-sheet-decoder', formulaAndOffscreenTail: true });
  const cdp = await browser.target().createCDPSession();
  // Exercise the actual toolbar popup in headless Chrome. All tab activation
  // below is confined to this temporary browser; no desktop window is created.
  await source.bringToFront();
  await task.evaluate(() => chrome.action.openPopup());
  const popupTarget = await browser.waitForTarget((target) => target !== task.target()
    && target.url() === `chrome-extension://${id}/extension/task.html`, { timeout: 10000 });
  let popup = await popupTarget.asPage();
  sessions.push(popup);
  await intercept(popup);
  await popup.waitForFunction(() => !document.getElementById('export').disabled, { timeout: 10000 });
  assert.equal(await popup.$eval('#source', (el) => el.textContent), new URL(sourceURL).hostname);
  await popup.screenshot({ path: resolve(output, 'toolbar-popup-ready.png') });
  // Render the real popup at its actual width. Hover must be visible without
  // moving the control, including with reduced motion in either appearance.
  for (const theme of ['light', 'dark']) {
    await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await popup.mouse.move(1, 1);
    const resting = await popup.$eval('#export', (el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { background: getComputedStyle(el).backgroundColor, box: { x, y, width, height } };
    });
    await popup.hover('#export');
    await popup.waitForFunction((previous) => getComputedStyle(document.getElementById('export')).backgroundColor !== previous, {}, resting.background);
    const hoveredBox = await popup.$eval('#export', (el) => { const { x, y, width, height } = el.getBoundingClientRect(); return { x, y, width, height }; });
    assert.deepEqual(hoveredBox, resting.box);
    await popup.screenshot({ path: resolve(output, `popup-hover-${theme}.png`) });
    await popup.click('#settings-open');
    assert.equal(await popup.$eval('#settings-save', (el) => el.disabled), true);
    assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await popup.focus('#settings-back');
    await popup.keyboard.press('Tab');
    assert.equal(await popup.$eval('#setting-format', (el) => el.matches(':focus-visible')), true);
    assert.equal(await popup.$eval('#setting-format', (el) => getComputedStyle(el).outlineStyle), 'solid');
    // Full-page capture of Chrome's native popup can tile beyond its surface.
    // Capture the real viewport and then its scrolled footer instead.
    await popup.screenshot({ path: resolve(output, `popup-settings-${theme}.png`) });
    await popup.$eval('#settings-save', (el) => el.scrollIntoView({ block: 'end' }));
    await popup.screenshot({ path: resolve(output, `popup-settings-footer-${theme}.png`) });
    await popup.click('#settings-back');
  }
  await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  results.push({ scenario: 'compact-ui', actualPopupScreenshots: true, lightDarkHoverWithoutLayoutShift: true, reducedMotion: true, keyboardFocusVisible: true });
  delayed = true;
  await popup.click('#export');
  await popup.waitForFunction(() => !document.getElementById('cancel').hidden, { timeout: 10000 });
  await popup.close();
  await task.evaluate(() => chrome.action.openPopup());
  const runningPopupTarget = await browser.waitForTarget((target) => target !== task.target()
    && target.url() === `chrome-extension://${id}/extension/task.html`, { timeout: 10000 });
  const runningPopup = await runningPopupTarget.asPage();
  sessions.push(runningPopup);
  await runningPopup.waitForFunction(() => !document.getElementById('cancel').hidden, { timeout: 10000 });
  assert.equal(await runningPopup.$eval('#export', (element) => element.disabled), true);
  const duplicate = await runningPopup.evaluate((source) => chrome.runtime.sendMessage({ target: 'export-service', command: 'start', source }), { id: sourceId, url: sourceURL });
  assert.match(duplicate.value?.error || duplicate.error || '', /already running/);
  await runningPopup.close();
  const offscreenTarget = await browser.waitForTarget((target) => target.url().endsWith('/extension/offscreen.html'), { timeout: 10000 });
  await attachOffscreen(offscreenTarget);
  const offscreen = await offscreenAttachments.get(offscreenTarget);
  const sourceTabs = await task.evaluate(() => chrome.tabs.query({}));
  assert.equal(sourceTabs.some((tab) => tab.url?.includes('offscreen.html')), false);
  await task.waitForFunction(async () => {
    const response = await chrome.runtime.sendMessage({ target: 'export-service', command: 'snapshot' });
    return response.value?.state?.status === 'complete';
  }, { timeout: 45000, polling: 100 });
  const lifecycle = await task.createCDPSession();
  await lifecycle.send('ServiceWorker.enable');
  await lifecycle.send('ServiceWorker.stopAllWorkers');
  await lifecycle.detach();
  await task.evaluate(() => chrome.action.openPopup());
  const reopenedTarget = await browser.waitForTarget((target) => target !== task.target()
    && target.url() === `chrome-extension://${id}/extension/task.html`, { timeout: 10000 });
  popup = await reopenedTarget.asPage();
  sessions.push(popup);
  await popup.waitForFunction(() => document.getElementById('status').textContent.includes('ZIP saved'), { timeout: 45000 });
  assert.equal(await popup.$eval('#verdict', (el) => el.textContent), 'COMPLETE');
  await expectBadge(sourceId, '✓');
  await expectBadge(taskId, '');
  assert.equal(await task.evaluate(() => chrome.action.getBadgeText({})), '');
  const popupDownload = await popup.evaluate(async () => (await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }))[0]);
  assert.equal(popupDownload.state, 'complete');
  const popupFiles = unzipSync(new Uint8Array(await readFile(popupDownload.filename)));
  const popupMarkdown = new TextDecoder().decode(popupFiles[Object.keys(popupFiles).find((name) => name.endsWith('.md'))]);
  assert.ok(popupMarkdown.includes('LAST-PAGE-SENTINEL'));
  assert.deepEqual(popupFiles[Object.keys(popupFiles).find((name) => name.endsWith('assets/image-1.png'))], imageBytes);
  await popup.screenshot({ path: resolve(output, 'toolbar-popup-complete.png') });
  results.push({ scenario: 'actual-toolbar-popup', automaticSource: true, exportComplete: true, downloadedArchiveVerified: true,
    continuedAfterPopupClosed: true, progressRestoredOnReopen: true, duplicateStartRejected: true,
    resultRestoredAfterServiceWorkerRestart: true, noVisibleWorkerTab: true });
  await popup.close();
  delayed = false;
  await task.bringToFront();
  async function run(verdict) {
    console.log(`Checking ${scenario}…`);
    await task.click('#export');
    await task.waitForFunction(() => !document.getElementById('export').disabled, { timeout: 45000 });
    const state = await task.evaluate(() => ({ verdict: document.getElementById('verdict').textContent, resultHidden: document.getElementById('result').hidden, status: document.getElementById('status').textContent }));
    assert.equal(state.resultHidden, false, JSON.stringify(state));
    assert.equal(state.verdict, verdict.toUpperCase(), JSON.stringify(state));
    await task.waitForFunction(() => document.getElementById('status').textContent.includes('ZIP saved'), { timeout: 10000 });
    await expectBadge(sourceId, verdict === 'complete' ? '✓' : '!');
    await expectBadge(taskId, '');
    assert.equal(await task.evaluate(() => chrome.action.getBadgeText({})), '');
    const download = await task.evaluate(async () => (await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }))[0]);
    assert.equal(download.state, 'complete');
    const archive = unzipSync(new Uint8Array(await readFile(download.filename)));
    const entries = Object.keys(archive);
    const report = JSON.parse(new TextDecoder().decode(archive[entries.find((name) => name.endsWith('/export-report.json'))]));
    assert.equal(report.documents[0].integrity.verdict, verdict);
    const markdown = new TextDecoder().decode(archive[entries.find((name) => name.endsWith('.md'))]);
    assert.ok(markdown.includes('FIRST-PAGE-SENTINEL'));
    if (scenario === 'complete') {
      assert.ok(markdown.includes('LAST-PAGE-SENTINEL'));
      assert.ok(markdown.includes('REPLY-SENTINEL'));
      assert.deepEqual(archive[entries.find((name) => name.endsWith('assets/image-1.png'))], imageBytes);
      assert.deepEqual(archive[entries.find((name) => name.includes('/attachments/'))], attachmentBytes);
    }
    results.push({ scenario, verdict, zipFiles: entries.length, downloadComplete: true });
  }
  // Feishu changes documents with same-tab history navigation. An old job
  // must never supply the current heading or a success verdict for the new URL.
  const secondURL = 'https://fixture.feishu.cn/docx/SecondFixture';
  await source.evaluate((url) => { history.pushState({}, '', url); document.title = 'Second document'; }, secondURL);
  await task.waitForFunction(() => document.getElementById('document-heading').textContent === 'Second document');
  assert.equal(await task.$eval('#result', (el) => el.hidden), true);
  assert.equal(await task.$eval('#download', (el) => el.hidden), true);
  assert.equal(await task.$eval('#status', (el) => el.textContent), 'Ready to export.');
  await expectBadge(sourceId, '');
  assert.equal(await task.$eval('#previous-title', (el) => el.textContent), 'Extension fixture Ω');
  assert.equal(await task.$eval('#previous-export', (el) => el.hidden), false);
  await task.click('#previous-download');
  await task.waitForFunction(() => !document.getElementById('previous-export').hidden && !document.getElementById('previous-download').disabled);
  const retainedJob = await task.evaluate(async () => (await chrome.runtime.sendMessage({ target: 'export-service', command: 'snapshot' })).value.state);
  assert.equal(retainedJob.source.url, sourceURL);
  await expectBadge(sourceId, '');
  await source.reload();
  await task.waitForFunction(() => document.getElementById('document-heading').textContent === 'Second document');
  // Reopening the actual toolbar popup must also prefer the active page.
  await source.bringToFront();
  await task.evaluate(() => chrome.action.openPopup());
  const switchedTarget = await browser.waitForTarget((target) => target !== task.target()
    && target.url() === `chrome-extension://${id}/extension/task.html`, { timeout: 10000 });
  const switchedPopup = await switchedTarget.asPage();
  await switchedPopup.waitForFunction(() => document.getElementById('document-heading').textContent === 'Second document'
    && !document.getElementById('previous-export').hidden);
  assert.equal(await switchedPopup.$eval('#result', (el) => el.hidden), true);
  await switchedPopup.screenshot({ path: resolve(output, 'popup-document-switched.png') });
  await switchedPopup.close();
  await task.bringToFront();
  await run('complete');
  const newJob = await task.evaluate(async () => (await chrome.runtime.sendMessage({ target: 'export-service', command: 'snapshot' })).value.state);
  assert.equal(newJob.source.url, secondURL);
  assert.equal(newJob.source.title, 'Second document');
  assert.equal(newJob.result.report.documents[0].title, 'Second document');
  assert.equal(await task.$eval('#previous-export', (el) => el.hidden), true);
  // A running job stays associated with its original document across navigation.
  delayed = true;
  await task.click('#export');
  await task.waitForFunction(() => !document.getElementById('cancel').hidden);
  await source.evaluate((url) => { history.pushState({}, '', url); document.title = 'Extension fixture Ω'; }, sourceURL);
  await task.waitForFunction(() => document.getElementById('document-heading').textContent === 'Extension fixture Ω'
    && document.getElementById('active-job').textContent === 'Exporting: Second document');
  assert.equal(await task.$eval('#export', (el) => el.disabled), true);
  await expectBadge(sourceId, '');
  await task.click('#cancel');
  await task.waitForFunction(() => !document.getElementById('export').disabled && !document.getElementById('previous-export').hidden);
  assert.match(await task.$eval('#previous-status', (el) => el.textContent), /cancelled/);
  delayed = false;
  // A persistent popup observer also follows active-tab changes and unsupported pages.
  const observer = await browser.newPage();
  await source.bringToFront();
  await observer.goto(`chrome-extension://${id}/extension/task.html`);
  await observer.waitForFunction(() => document.getElementById('document-heading').textContent === 'Extension fixture Ω');
  await task.bringToFront();
  await observer.waitForFunction(() => document.getElementById('export').disabled
    && document.getElementById('document-heading').textContent === 'Open a Feishu document');
  await source.bringToFront();
  await observer.waitForFunction(() => !document.getElementById('export').disabled);
  await observer.close();
  await task.bringToFront();
  results.push({ scenario: 'document-switch', sameTabSPAFollowed: true, reloadFollowed: true, reopenUsesCurrentDocument: true,
    previousResultSeparated: true, previousDownloadRetained: true, nextExportUsesNewURL: true,
    runningJobKeepsOriginalSource: true, activeTabChangesFollowed: true, unsupportedPageDisabled: true });
  await run('complete');
  // A late completion must not mark an unrelated page in the same tab.
  delayed = true;
  await task.click('#export');
  await expectBadge(sourceId, '…');
  await source.evaluate(() => { history.pushState({}, '', '/home'); document.title = 'Unrelated page'; });
  await expectBadge(sourceId, '');
  await task.waitForFunction(async (tabId) => !await chrome.action.isEnabled(tabId), {}, sourceId);
  await task.waitForFunction(async () => {
    const response = await chrome.runtime.sendMessage({ target: 'export-service', command: 'snapshot' });
    return response.value?.state?.status === 'complete';
  }, { timeout: 45000, polling: 100 });
  await expectBadge(sourceId, '');
  await expectBadge(taskId, '');
  // Force worker recovery while the source tab is now on another page.
  const badgeLifecycle = await task.createCDPSession();
  await badgeLifecycle.send('ServiceWorker.enable');
  await badgeLifecycle.send('ServiceWorker.stopAllWorkers');
  await badgeLifecycle.detach();
  await task.evaluate(() => chrome.runtime.sendMessage({ target: 'export-service', command: 'snapshot' }));
  await expectBadge(sourceId, '');
  assert.equal(await task.evaluate(() => chrome.action.getBadgeText({})), '');
  delayed = false;
  await source.evaluate((url) => { history.pushState({}, '', url); document.title = 'Extension fixture Ω'; }, sourceURL);
  await expectBadge(sourceId, '✓');
  await source.reload();
  await expectBadge(sourceId, '✓');
  await task.waitForFunction(() => !document.getElementById('export').disabled && !document.getElementById('result').hidden);
  results.push({ scenario: 'document-scoped-badges', globalBadgeEmpty: true, otherTabsUnmarked: true,
    navigationClearsBadge: true, lateCompletionOnUnrelatedPageUnmarked: true,
    workerRestartRespectsCurrentPage: true, returningToSourceRestoresBadge: true, refreshRestoresBadge: true });
  await task.screenshot({ path: resolve(output, 'complete-light.png'), fullPage: true });
  await task.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await task.screenshot({ path: resolve(output, 'complete-dark.png'), fullPage: true });
  await task.setViewport({ width: 390, height: 844 });
  assert.equal(await task.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await task.screenshot({ path: resolve(output, 'complete-narrow.png'), fullPage: true });
  await task.setViewport({ width: 1100, height: 900 });
  scenario = 'media-failure';
  await run('incomplete');
  await task.screenshot({ path: resolve(output, 'incomplete.png'), fullPage: true });
  scenario = 'comment-failure';
  await run('degraded');
  scenario = 'missing-block';
  await run('incomplete');
  scenario = 'complete';
  delayed = true;
  const before = await task.evaluate(async () => (await chrome.downloads.search({})).length);
  await task.click('#export');
  await task.click('#cancel');
  await task.waitForFunction(() => document.getElementById('status').textContent.includes('Export cancelled'), { timeout: 10000 });
  assert.equal(await task.evaluate(async () => (await chrome.downloads.search({})).length), before);
  results.push({ scenario: 'cancel', noDownload: true });
  delayed = false;
  await run('complete');
  // Use the visible settings controls; confirm persistence and actual files,
  // rather than only asserting that preferences were written to storage.
  await task.setViewport({ width: 360, height: 580 });
  await task.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await task.click('#settings-open');
  await task.select('#setting-theme', 'dark');
  assert.equal(await task.$eval('body', (el) => getComputedStyle(el).backgroundColor), 'rgb(32, 35, 40)');
  await task.select('#setting-format', 'folder');
  await task.type('#setting-subfolder', 'QA/Exports');
  await task.click('#settings-save');
  await task.waitForFunction(() => document.getElementById('settings-status').textContent.startsWith('Settings saved'));
  await task.screenshot({ path: resolve(output, 'settings-dark.png'), fullPage: true });
  await task.reload();
  await task.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await task.$eval('#format-label', (el) => el.textContent), 'Markdown folder');
  await task.click('#settings-open');
  assert.equal(await task.$eval('#setting-subfolder', (el) => el.value), 'QA/Exports');
  assert.equal(await task.$eval('#setting-ask', (el) => el.disabled), true);
  await task.$eval('#setting-subfolder', (el) => { el.value = '../outside'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await task.waitForFunction(() => document.getElementById('settings-status').classList.contains('error'));
  assert.equal(await task.$eval('#settings-save', (el) => el.disabled), true);
  assert.equal(await task.evaluate(async () => (await chrome.storage.local.get('settings')).settings.subfolder), 'QA/Exports');
  await task.$eval('#setting-subfolder', (el) => { el.value = 'QA/Exports'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await task.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await task.select('#setting-theme', 'light');
  assert.equal(await task.$eval('body', (el) => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
  await task.click('#settings-save');
  await task.waitForFunction(() => document.getElementById('settings-status').textContent.startsWith('Settings saved'));
  await task.screenshot({ path: resolve(output, 'settings-light.png'), fullPage: true });
  await task.select('#setting-theme', 'system');
  assert.equal(await task.$eval('body', (el) => getComputedStyle(el).backgroundColor), 'rgb(32, 35, 40)');
  await task.click('#settings-save');
  await task.waitForFunction(() => document.getElementById('settings-status').textContent.startsWith('Settings saved'));
  assert.equal(await task.$eval('#settings-save', (el) => el.disabled), true);
  await task.click('#clear-subfolder');
  assert.equal(await task.$eval('#settings-save', (el) => el.disabled), false);
  assert.equal(await task.$eval('#settings-status', (el) => el.textContent), 'Unsaved changes');
  await task.click('#settings-save');
  await task.waitForFunction(() => document.getElementById('settings-status').textContent.startsWith('Settings saved'));
  await task.reload();
  await task.waitForFunction(() => document.getElementById('destination').textContent === 'Save to: Chrome downloads');
  await task.click('#settings-open');
  assert.equal(await task.$eval('#setting-subfolder', (el) => el.value), '');
  assert.equal(await task.$eval('#settings-save', (el) => el.disabled), true);
  await task.type('#setting-subfolder', 'QA/Exports');
  await task.click('#settings-save');
  await task.waitForFunction(() => document.getElementById('settings-status').textContent.startsWith('Settings saved'));
  await task.click('#settings-back');
  results.push({ scenario: 'settings', persistedAfterReopen: true, invalidPathRejected: true, explicitLightDarkAndSystem: true, clearOverridePersists: true, unchangedSaveDisabled: true });

  await source.bringToFront();
  await task.evaluate(() => chrome.action.openPopup());
  const folderPopupTarget = await browser.waitForTarget((target) => target !== task.target()
    && target.url() === `chrome-extension://${id}/extension/task.html`, { timeout: 10000 });
  const folderPopup = await folderPopupTarget.asPage();
  sessions.push(folderPopup);
  await folderPopup.waitForFunction(() => !document.getElementById('export').disabled);
  delayed = true;
  await folderPopup.click('#export');
  await folderPopup.waitForFunction(() => !document.getElementById('cancel').hidden);
  await folderPopup.close();
  await task.waitForFunction(async () => {
    const { value } = await chrome.runtime.sendMessage({ target: 'export-service', command: 'snapshot' });
    return value?.state?.status === 'complete' && value.state.settings?.format === 'folder';
  }, { timeout: 45000, polling: 100 });
  delayed = false;
  await task.bringToFront();
  const folderState = await task.evaluate(async () => (await chrome.runtime.sendMessage({ target: 'export-service', command: 'snapshot' })).value.state);
  assert.ok(folderState.destination.startsWith('QA/Exports/'));
  assert.equal(folderState.savedFiles, folderState.result.fileCount);
  const folderDownloads = await task.evaluate(async (directory) => (await chrome.downloads.search({})).filter((item) => item.filename.includes(`/${directory}/`)), folderState.destination);
  assert.equal(folderDownloads.length, folderState.result.fileCount);
  assert.ok(folderDownloads.every((item) => item.state === 'complete'));
  const folderMarkdown = await readFile(folderDownloads.find((item) => item.filename.endsWith('.md')).filename, 'utf8');
  assert.ok(folderMarkdown.includes('LAST-PAGE-SENTINEL') && folderMarkdown.includes('assets/image-1.png'));
  assert.deepEqual(new Uint8Array(await readFile(folderDownloads.find((item) => item.filename.endsWith('/assets/image-1.png')).filename)), imageBytes);
  assert.deepEqual(new Uint8Array(await readFile(folderDownloads.find((item) => item.filename.includes('/attachments/')).filename)), attachmentBytes);
  await task.click('#download');
  await task.waitForFunction((previous) => document.getElementById('status').textContent.startsWith('Folder saved:')
    && !document.getElementById('status').textContent.includes(previous), { timeout: 30000 }, folderState.destination);
  results.push({ scenario: 'folder-export', backgroundCompletion: true, customSubfolder: true, fileBytesAndLinksVerified: true, uniqueDirectoryOnRepeat: true });

  await task.click('#settings-open');
  await task.select('#setting-format', 'zip');
  await task.click('#settings-save');
  await task.waitForFunction(() => document.getElementById('settings-status').textContent.startsWith('Settings saved'));
  await task.click('#settings-back');
  await run('complete');
  const locatedZIP = await task.evaluate(async () => (await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }))[0]);
  assert.ok(locatedZIP.filename.includes('/QA/Exports/'));
  results.push({ scenario: 'zip-custom-location', subfolderApplied: true });
  await source.close();
  await task.waitForFunction(() => document.getElementById('export').disabled
    && document.getElementById('document-heading').textContent === 'Open a Feishu document', { timeout: 10000 });
  assert.equal(await task.$eval('#result', (el) => el.hidden), true);
  assert.match(await task.$eval('#status', (el) => el.textContent), /Switch to a Feishu or Lark document/);
  results.push({ scenario: 'source-tab-closed', exportDisabled: true, previousResultSeparated: true });
  // Validate a file-only upgrade, so daily Chrome can reload on the user's next
  // click without us opening its extension manager or taking desktop focus.
  // CDP installation bypasses the Developer mode setting, but runtime.reload()
  // does not. Match the user's already-enabled setting in this disposable,
  // headless profile only; never change the daily Chrome profile here.
  const testManager = await browser.newPage();
  await testManager.goto('chrome://extensions/');
  await testManager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await testManager.close();
  upgradeDirectory = await realpath(await mkdtemp(resolve(tmpdir(), 'feishu-extension-upgrade-')));
  await cp(resolve(root, 'dist/Feishu Grabber Extension'), upgradeDirectory, { recursive: true });
  const manifestPath = resolve(upgradeDirectory, 'manifest.json');
  const currentManifest = await readFile(manifestPath, 'utf8');
  const legacyManifest = JSON.parse(currentManifest);
  legacyManifest.version = '0.1.0';
  legacyManifest.permissions = legacyManifest.permissions.filter((permission) => !['offscreen', 'storage', 'debugger'].includes(permission));
  await writeFile(manifestPath, JSON.stringify(legacyManifest));
  const popupScript = resolve(upgradeDirectory, 'extension/task.mjs');
  const currentPopupScript = await readFile(popupScript, 'utf8');
  await writeFile(popupScript, "document.body.textContent = 'Legacy popup';");
  const upgradeId = await browser.installExtension(upgradeDirectory);
  const upgradePage = await browser.newPage();
  sessions.push(upgradePage);
  await upgradePage.goto(`chrome-extension://${upgradeId}/extension/task.html`);
  await upgradePage.waitForFunction(() => document.body.textContent === 'Legacy popup');
  await upgradePage.evaluate(() => chrome.runtime.sendMessage({ target: 'export-service', command: 'snapshot' }));
  await writeFile(manifestPath, currentManifest);
  await writeFile(popupScript, currentPopupScript);
  const oldContextClosed = new Promise((resolveClose, reject) => {
    const timer = setTimeout(() => reject(new Error('The old extension context did not reload.')), 10000);
    upgradePage.once('close', () => { clearTimeout(timer); resolveClose(); });
  });
  await upgradePage.reload().catch(() => {}); // Self-reload can detach the old extension context.
  await oldContextClosed;
  let installedUpgrade;
  const reloadDeadline = Date.now() + 10000;
  do {
    installedUpgrade = (await cdp.send('Extensions.getExtensions')).extensions.find((extension) => extension.id === upgradeId);
    if (installedUpgrade?.enabled && installedUpgrade.version === '0.2.7') break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  } while (Date.now() < reloadDeadline);
  assert.ok(installedUpgrade?.enabled && installedUpgrade.version === '0.2.7', JSON.stringify(installedUpgrade));
  const updatedPopup = await browser.newPage();
  sessions.push(updatedPopup);
  await updatedPopup.goto(`chrome-extension://${upgradeId}/extension/task.html`);
  const upgradedManifest = await updatedPopup.evaluate(() => chrome.runtime.getManifest());
  assert.equal(upgradedManifest.version, '0.2.7');
  assert.ok(upgradedManifest.permissions.includes('offscreen'));
  assert.ok(upgradedManifest.permissions.includes('storage'));
  assert.ok(upgradedManifest.permissions.includes('debugger'));
  results.push({ scenario: 'file-only-upgrade', manifestReloadedOnNextOpen: true, offscreenPermissionRegistered: true });
  assert.ok(csrfChecked >= 2);
  assert.deepEqual(errors, []);
  const launchArgs = browser.process().spawnargs;
  const evidence = { generatedAt: new Date().toISOString(), browser: await browser.version(), extensionId: id, mode: 'headless-isolated-synthetic-network', headless: launchArgs.some((arg) => arg.startsWith('--headless')), temporaryProfile: launchArgs.includes(`--user-data-dir=${profileDirectory}`), liveAccountTested: false, csrfChecked, results, errors };
  await writeFile(resolve(output, 'results.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  for (const [index, page] of sessions.entries()) {
    if (!page.isClosed()) {
      console.error(`Page ${index}:`, await page.evaluate(() => document.body.innerText).catch(() => 'unavailable'));
      await page.screenshot({ path: resolve(output, `failure-${index}.png`), fullPage: true }).catch(() => {});
    }
  }
  console.error('Page errors:', errors);
  throw error;
} finally {
  await browser.close();
  await rm(profileDirectory, { recursive: true, force: true });
  if (upgradeDirectory) await rm(upgradeDirectory, { recursive: true, force: true });
}
