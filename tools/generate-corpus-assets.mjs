#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('tests/generated');
const mediaDir = join(root, 'media');
const attachmentDir = join(root, 'attachments');
const bundledPython = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
const python = process.env.CORPUS_PYTHON || (existsSync(bundledPython) ? bundledPython : 'python3');
mkdirSync(mediaDir, { recursive: true });
mkdirSync(attachmentDir, { recursive: true });

function ppm(path, width, height, kind) {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      let rgb;
      if (kind === 'small') {
        const quadrant = (x >= width / 2 ? 1 : 0) + (y >= height / 2 ? 2 : 0);
        rgb = [[239, 68, 68], [34, 197, 94], [59, 130, 246], [250, 204, 21]][quadrant];
        if (Math.abs(x / width - y / height) < 0.04) rgb = [255, 255, 255];
      } else if (kind === 'photo') {
        const horizon = Math.floor(height * 0.62);
        if (y < horizon) {
          rgb = [40 + Math.floor(y * 0.18), 120 + Math.floor(y * 0.2), 205 + Math.floor(y * 0.08)];
          const dx = x - width * 0.78;
          const dy = y - height * 0.23;
          if (dx * dx + dy * dy < (height * 0.1) ** 2) rgb = [255, 226, 92];
        } else {
          const stripe = Math.floor(x / 42) % 2;
          rgb = stripe ? [39, 126, 74] : [54, 151, 88];
        }
      } else {
        const tile = (Math.floor(x / 110) + Math.floor(y / 100)) % 2;
        rgb = tile ? [17, 24, 39] : [31, 41, 55];
        if (Math.abs((x + y) % 360 - 180) < 18) rgb = [34, 211, 238];
        if (Math.abs((x - y + height) % 520 - 260) < 16) rgb = [244, 63, 94];
      }
      [pixels[offset], pixels[offset + 1], pixels[offset + 2]] = rgb;
    }
  }
  writeFileSync(path, Buffer.concat([header, pixels]));
}

function convert(source, format, destination) {
  const result = spawnSync('/usr/bin/sips', ['-s', 'format', format, source, '--out', destination], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `sips failed for ${destination}`);
}

const smallPpm = join(mediaDir, 'small.ppm');
const photoPpm = join(mediaDir, 'photo.ppm');
const largePpm = join(mediaDir, 'large.ppm');
ppm(smallPpm, 96, 64, 'small');
ppm(photoPpm, 640, 360, 'photo');
ppm(largePpm, 2200, 1400, 'large');
convert(smallPpm, 'png', join(mediaDir, 'fixture-small.png'));
convert(photoPpm, 'jpeg', join(mediaDir, 'fixture-photo.jpg'));
convert(largePpm, 'png', join(mediaDir, 'fixture-large.png'));
rmSync(smallPpm);
rmSync(photoPpm);
rmSync(largePpm);

writeFileSync(join(mediaDir, 'fixture-vector.svg'), `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#eef2ff"/>
  <circle cx="180" cy="180" r="110" fill="#4f46e5"/>
  <path d="M300 80 L560 180 L300 280 Z" fill="#f97316"/>
  <text x="320" y="335" text-anchor="middle" font-family="sans-serif" font-size="24">SVG-FIXTURE-Ω</text>
</svg>
`);
convert(join(mediaDir, 'fixture-vector.svg'), 'png', join(mediaDir, 'fixture-vector.png'));

const textAttachment = join(attachmentDir, 'fixture.txt');
writeFileSync(textAttachment, 'ATTACHMENT-TEXT-4E71\n');
utimesSync(textAttachment, new Date('2020-01-02T03:04:06Z'), new Date('2020-01-02T03:04:06Z'));
writeFileSync(join(attachmentDir, '中文附件-Ω.txt'), 'UNICODE-ATTACHMENT-19AF\n');
writeFileSync(join(attachmentDir, 'NO_EXTENSION'), 'NO-EXTENSION-CONTENT-73D2\n');
const pdf = spawnSync(python, [resolve('tools/generate-pdf-attachment.py'), join(attachmentDir, 'fixture.pdf')], {
  encoding: 'utf8',
});
if (pdf.status !== 0) throw new Error(pdf.stderr || pdf.stdout || 'PDF fixture generation failed');

rmSync(join(attachmentDir, 'fixture.zip'), { force: true });
const zip = spawnSync('/usr/bin/zip', ['-q', '-X', '-j', join(attachmentDir, 'fixture.zip'), textAttachment], { encoding: 'utf8' });
if (zip.status !== 0) throw new Error(zip.stderr || 'zip failed');

const files = [
  'media/fixture-small.png',
  'media/fixture-photo.jpg',
  'media/fixture-vector.svg',
  'media/fixture-vector.png',
  'media/fixture-large.png',
  'attachments/fixture.txt',
  'attachments/fixture.pdf',
  'attachments/fixture.zip',
  'attachments/中文附件-Ω.txt',
  'attachments/NO_EXTENSION',
];
const manifest = files.map((file) => {
  const data = readFileSync(join(root, file));
  return { file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
});
writeFileSync(join(root, 'asset-manifest.json'), JSON.stringify({ schemaVersion: 1, files: manifest }, null, 2) + '\n');
const docx = spawnSync(python, [resolve('tools/generate-image-fixture.py')], { encoding: 'utf8' });
if (docx.status !== 0) throw new Error(docx.stderr || docx.stdout || 'DOCX fixture generation failed');
console.log(`Generated ${manifest.length} deterministic corpus assets and FG-05 Images.docx under ${root}`);
