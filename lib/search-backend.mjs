import { browserOSAvailable, searchWithBrowserOS } from './browseros.mjs';
import { DailyChrome } from './daily-chrome.mjs';
import { parseSearchResults, searchURL } from './search.mjs';
import { saveWorkspace, savedWorkspace } from './workspace-state.mjs';

// Prefers BrowserOS neo so the user's everyday Chrome is never touched.
export async function searchKnowledgeBase(query, { count = 20, offset = 0, site = null, timeoutMs = 180000 } = {}, deps = {}) {
  const target = site || savedWorkspace();
  if (await (deps.available ?? browserOSAvailable)()) {
    const { payload, url } = await (deps.browserOSSearch ?? searchWithBrowserOS)(query, { count, offset, site: target }, { searchURL });
    const result = parseSearchResults(JSON.parse(payload), new URL(url).origin);
    if (!savedWorkspace()) saveWorkspace(`${new URL(url).origin}/drive/home/`);
    return { result, backend: 'browseros' };
  }
  const chrome = (deps.chrome ?? (() => new DailyChrome({ timeoutMs })))();
  try {
    const open = await chrome.workspaceHome().catch(() => null);
    const workspace = target || open;
    if (!workspace) throw new Error('Open a Feishu tab in Chrome once, or start BrowserOS neo, then rerun.');
    await chrome.prepareWorkspace(workspace);
    saveWorkspace(`${new URL(workspace).origin}/drive/home/`);
    return { result: await chrome.search(query, { count, offset }), backend: 'chrome' };
  } finally {
    await chrome.disconnect().catch(() => {});
  }
}
