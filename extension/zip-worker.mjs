import { zipSync } from '../vendor/fflate.mjs';
self.onmessage = ({ data }) => {
  try {
    const entries = Object.create(null);
    for (const [path, bytes] of Object.entries(data.files)) entries[`${data.title}/${path}`] = bytes;
    const archive = zipSync(entries, { level: 0 });
    self.postMessage({ archive }, [archive.buffer]);
  } catch (error) { self.postMessage({ error: error.message }); }
};
