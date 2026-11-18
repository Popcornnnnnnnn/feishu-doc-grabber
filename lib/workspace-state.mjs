import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function statePath() {
  return process.env.FEISHU_GRAB_STATE || join(homedir(), '.feishu-grab.json');
}

// Remembers the tenant so later searches need no --site.
export function savedWorkspace(path = statePath()) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')).workspace;
    return typeof value === 'string' && value ? value : null;
  } catch { return null; }
}

export function saveWorkspace(url, path = statePath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ workspace: url }, null, 2)}\n`);
  } catch { /* remembering the site is best effort */ }
}
