import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { zipSync } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, 'dist/Feishu Grabber Extension');
await mkdir(resolve(out, 'extension'), { recursive: true });
await mkdir(resolve(out, 'lib'), { recursive: true });
await mkdir(resolve(out, 'vendor'), { recursive: true });
await mkdir(resolve(out, 'icons'), { recursive: true });
for (const entry of await readdir(resolve(root, 'extension'))) {
  if (entry === 'manifest.json') await copyFile(resolve(root, 'extension', entry), resolve(out, entry));
  else if (/\.(mjs|html|css)$/.test(entry)) await copyFile(resolve(root, 'extension', entry), resolve(out, 'extension', entry));
}
for (const name of ['ssr', 'comments', 'integrity', 'media', 'sheet']) {
  const code = (await readFile(resolve(root, `lib/${name}.mjs`), 'utf8')).replace("from 'fflate'", "from '../vendor/fflate.mjs'");
  await writeFile(resolve(out, `lib/${name}.mjs`), code);
}
await copyFile(resolve(root, 'node_modules/fflate/esm/browser.js'), resolve(out, 'vendor/fflate.mjs'));
await copyFile(resolve(root, 'node_modules/fflate/LICENSE'), resolve(out, 'vendor/fflate-LICENSE.txt'));
for (const size of [16, 32, 48, 128]) await copyFile(resolve(root, `extension/icons/${size}.png`), resolve(out, `icons/${size}.png`));
await copyFile(resolve(root, 'extension/README.md'), resolve(out, 'README.md'));
const entries = Object.create(null);
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await collect(path);
    else entries[relative(out, path)] = new Uint8Array(await readFile(path));
  }
}
await collect(out);
const { version } = JSON.parse(await readFile(resolve(out, 'manifest.json'), 'utf8'));
const archivePath = resolve(root, `dist/Feishu-Grabber-Extension-${version}.zip`);
await writeFile(archivePath, zipSync(entries, { level: 6 }));
console.log(`Extension: ${out}\nPackage: ${archivePath}`);
