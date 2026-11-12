export const DEFAULT_SETTINGS = Object.freeze({ format: 'zip', subfolder: '', askWhere: false, theme: 'system', whiteboards: 'auto' });

export function normalizeSettings(value = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...value };
  if (!['zip', 'folder'].includes(settings.format)) throw new Error('Choose ZIP or Folder.');
  if (!['system', 'light', 'dark'].includes(settings.theme)) throw new Error('Choose System, Light or Dark appearance.');
  if (!['auto', 'off'].includes(settings.whiteboards)) throw new Error('Choose whether to capture whiteboards as screenshots.');
  const subfolder = String(settings.subfolder || '').trim();
  if (subfolder && (subfolder.length > 120 || /[\\<>:"|?*\u0000-\u001f]/.test(subfolder)
    || subfolder.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))) {
    throw new Error('Enter a relative subfolder such as Feishu Exports or Work/Docs. Absolute paths and .. are not allowed.');
  }
  return { format: settings.format, subfolder, askWhere: settings.askWhere === true, theme: settings.theme, whiteboards: settings.whiteboards };
}

export function downloadPath(subfolder, filename) {
  return subfolder ? `${subfolder}/${filename}` : filename;
}
