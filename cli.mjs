#!/usr/bin/env node

import { main } from './grab.mjs';

const argv = process.argv.slice(2);
if (!argv.includes('--browser')) argv.unshift('--browser', 'chrome');
main(argv).catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
});
