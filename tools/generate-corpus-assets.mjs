#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('tests/generated');
const mediaDir = join(root, 'media');
const attachmentDir = join(root, 'attachments');
mkdirSync(mediaDir, { recursive: true });
mkdirSync(attachmentDir, { recursive: true });

function ppm(path, width, height, seed) {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 13 + seed) % 256;
      pixels[offset + 1] = (y * 17 + seed * 3) % 256;
      pixels[offset + 2] = ((x + y) * 7 + seed * 5) % 256;
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
ppm(smallPpm, 96, 64, 11);
ppm(photoPpm, 640, 360, 29);
ppm(largePpm, 2200, 1400, 47);
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

const textAttachment = join(attachmentDir, 'fixture.txt');
writeFileSync(textAttachment, 'ATTACHMENT-TEXT-4E71\n');
utimesSync(textAttachment, new Date('2020-01-02T03:04:06Z'), new Date('2020-01-02T03:04:06Z'));
writeFileSync(join(attachmentDir, '中文附件-Ω.txt'), 'UNICODE-ATTACHMENT-19AF\n');
writeFileSync(join(attachmentDir, 'NO_EXTENSION'), 'NO-EXTENSION-CONTENT-73D2\n');
writeFileSync(join(attachmentDir, 'fixture.pdf'), `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 59>>stream
BT /F1 18 Tf 36 72 Td (PDF-ATTACHMENT-5C21) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
trailer<</Root 1 0 R/Size 6>>
startxref
0
%%EOF
`);

rmSync(join(attachmentDir, 'fixture.zip'), { force: true });
const zip = spawnSync('/usr/bin/zip', ['-q', '-X', '-j', join(attachmentDir, 'fixture.zip'), textAttachment], { encoding: 'utf8' });
if (zip.status !== 0) throw new Error(zip.stderr || 'zip failed');

const files = [
  'media/fixture-small.png',
  'media/fixture-photo.jpg',
  'media/fixture-vector.svg',
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
console.log(`Generated ${manifest.length} deterministic corpus assets under ${root}`);
