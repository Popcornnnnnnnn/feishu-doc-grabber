import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function statePath() {
  return process.env.FEISHU_GRAB_STATE || join(homedir(), '.feishu-grab.json');
}

export function readState(path = statePath()) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function updateState(patch, path = statePath()) {
  const next = { ...readState(path) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    /* persisting local state is best effort */
  }
  return next;
}

// Remembers the tenant so later searches need no --site.
export function savedWorkspace(path = statePath()) {
  const value = readState(path).workspace;
  return typeof value === 'string' && value ? value : null;
}

export function saveWorkspace(url, path = statePath()) {
  updateState({ workspace: url || null }, path);
}

export function savedDefaultOut(path = statePath()) {
  const entry = readState(path).defaultOut;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (entry.mode === 'cwd') return { mode: 'cwd' };
  if (entry.mode === 'dir' && typeof entry.path === 'string' && entry.path.trim()) {
    return { mode: 'dir', path: entry.path };
  }
  return null;
}

export function resolveDefaultOut(path = statePath(), cwd = process.cwd()) {
  const saved = savedDefaultOut(path);
  if (saved?.mode === 'cwd') return cwd;
  if (saved?.mode === 'dir') return saved.path;
  return join(homedir(), 'Downloads');
}

export function saveDefaultOut(setting, path = statePath()) {
  if (setting === null) {
    updateState({ defaultOut: null }, path);
    return null;
  }
  if (!setting || typeof setting !== 'object') {
    throw new Error('Default output must be null, cwd, or a directory path.');
  }
  if (setting.mode === 'cwd') {
    const normalized = { mode: 'cwd' };
    updateState({ defaultOut: normalized }, path);
    return normalized;
  }
  if (setting.mode === 'dir' && typeof setting.path === 'string' && setting.path.trim()) {
    const normalized = { mode: 'dir', path: resolve(setting.path) };
    updateState({ defaultOut: normalized }, path);
    return normalized;
  }
  throw new Error('Default output must be null, cwd, or a directory path.');
}

export function savedLastReport(path = statePath()) {
  const value = readState(path).lastReport;
  return typeof value === 'string' && value.trim() ? value : null;
}

export function saveLastReport(reportPath, path = statePath()) {
  updateState({ lastReport: reportPath ? resolve(reportPath) : null }, path);
}
