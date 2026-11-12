const startsWith = (buffer, bytes) => bytes.every((byte, index) => buffer[index] === byte);
const textOf = (buffer) => new TextDecoder().decode(buffer);

export function imageExtension(buffer) {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpg';
  if (textOf(buffer.subarray(0, 6)) === 'GIF87a'
    || textOf(buffer.subarray(0, 6)) === 'GIF89a') return 'gif';
  if (textOf(buffer.subarray(0, 4)) === 'RIFF'
    && textOf(buffer.subarray(8, 12)) === 'WEBP') return 'webp';
  const text = textOf(buffer.subarray(0, 512)).trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(text)) return 'svg';
  return null;
}

export function validateDownloadedPayload(buffer, { kind, contentType = '' }) {
  if (!(buffer instanceof Uint8Array) || buffer.length === 0) throw new Error('empty response body');
  const text = textOf(buffer.subarray(0, 512)).trimStart();
  if (/json/i.test(contentType) || /^\{\s*"(?:code|message)"\s*:/.test(text)) {
    let detail = 'JSON error payload';
    try {
      const parsed = JSON.parse(text);
      detail = parsed.message || parsed.msg || detail;
    } catch {}
    throw new Error(detail);
  }
  if (/html/i.test(contentType) || /^<!doctype html|^<html\b/i.test(text)) {
    throw new Error('HTML response received instead of media');
  }
  if (kind === 'image') {
    const extension = imageExtension(buffer);
    if (!extension) throw new Error(`unrecognized image payload (${contentType || 'unknown content type'})`);
    return { extension };
  }
  return { extension: null };
}
