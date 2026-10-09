#!/usr/bin/env node

import { runCLI } from './lib/cli.mjs';

runCLI(process.argv.slice(2)).catch((error) => {
  console.error(`✗ ${error.message}`);
  if (error.exitCode === 64) console.error('Run feishu-grab --help for usage.');
  process.exitCode = error.exitCode || 1;
});
