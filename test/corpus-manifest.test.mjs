import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'tests/corpus/manifest.json');
const raw = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(raw);

test('corpus manifest has unique, auditable cases without tenant URLs', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.cases.length >= 10);
  assert.equal(new Set(manifest.cases.map((item) => item.id)).size, manifest.cases.length);
  assert.doesNotMatch(raw, /https?:\/\//);

  const sentinels = [];
  for (const item of manifest.cases) {
    assert.match(item.id, /^FG-\d{2}$/);
    assert.ok(item.title);
    assert.ok(item.state);
    assert.ok(item.setup);
    assert.equal(typeof item.foregroundRequired, 'boolean');
    assert.ok(item.coverage.length > 0);
    assert.equal(item.expect.integrity, 'complete');
    assert.ok(item.expect.sentinels.length > 0);
    sentinels.push(...item.expect.sentinels);

    if (item.source && item.state !== 'generator_ready') {
      assert.ok(existsSync(resolve(root, item.source)), `missing source for ${item.id}`);
    }
    if (item.state === 'generator_ready') assert.ok(item.generator);
  }
  assert.equal(new Set(sentinels).size, sentinels.length);
});
