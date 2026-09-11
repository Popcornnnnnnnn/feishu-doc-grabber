const startsWith = (buffer, bytes) => bytes.every((byte, index) => buffer[index] === byte);

export function imageExtension(buffer) {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpg';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a'
    || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  const text = buffer.subarray(0, 512).toString('utf8').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(text)) return 'svg';
  return null;
}

export function validateDownloadedPayload(buffer, { kind, contentType = '' }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('empty response body');
  const text = buffer.subarray(0, 512).toString('utf8').trimStart();
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
