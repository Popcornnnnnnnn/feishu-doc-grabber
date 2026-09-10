#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const output = resolve(process.argv[2] || 'tests/generated/FG-04 Long Document.md');
const sections = Number(process.argv[3] || 240);
const lines = [
  '# FG-04 Long Document',
  '',
  'This generated document verifies long-document pagination, ordering, and tail completeness.',
  '',
];

for (let i = 1; i <= sections; i += 1) {
  const id = String(i).padStart(4, '0');
  lines.push(`## Section ${id}`, '');
  lines.push(`Paragraph ${id}: LONG-BLOCK-${id} preserves deterministic order across export routes.`, '');
  lines.push(`- Item ${id}-A`, `- Item ${id}-B`, '');
}

lines.push(`Final sentinel: LONG-END-${String(sections).padStart(4, '0')}`, '');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, lines.join('\n'));
console.log(output);
