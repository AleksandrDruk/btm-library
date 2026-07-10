#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { validateRepository } from './validate-catalog.mjs';

const javascriptFiles = [
  'app.js',
  'lib/catalog.js',
  'lib/crypto.js',
  'lib/image.js',
  'worker/github.js',
  'worker/index.js',
  'scripts/check.mjs',
  'scripts/dev-server.mjs',
  'scripts/generate-password-hash.mjs',
  'scripts/generate-session-secret.mjs',
  'scripts/inspect-images.mjs',
  'scripts/validate-catalog.mjs',
];

for (const file of javascriptFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

JSON.parse(await readFile('config.json', 'utf8'));
JSON.parse(await readFile('package.json', 'utf8'));
await validateRepository('.');

const browserCode = await readFile('app.js', 'utf8');
const forbiddenPatterns = [
  ['innerHTML', /\.innerHTML\s*=/],
  ['document.write', /document\.write\s*\(/],
  ['eval', /\beval\s*\(/],
  ['new Function', /new\s+Function\s*\(/],
  ['localStorage', /\blocalStorage\b/],
  ['sessionStorage', /\bsessionStorage\b/],
];
for (const [name, pattern] of forbiddenPatterns) {
  if (pattern.test(browserCode)) {
    throw new Error(`Forbidden browser pattern found: ${name}`);
  }
}

process.stdout.write('Static checks passed.\n');
