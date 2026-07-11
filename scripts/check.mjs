#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { validateRepository } from './validate-catalog.mjs';

const javascriptFiles = [
  'app.js',
  'lib/affiliate-catalog.js',
  'lib/catalog.js',
  'lib/crypto.js',
  'lib/image.js',
  'worker/github.js',
  'worker/affiliate-catalog-state.js',
  'worker/affiliate-nonce.js',
  'worker/index.js',
  'scripts/check.mjs',
  'scripts/dev-server.mjs',
  'scripts/generate-password-hash.mjs',
  'scripts/generate-session-secret.mjs',
  'scripts/generate-site-credential.mjs',
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

const validatorWorkflow = await readFile('.github/workflows/validate-catalog.yml', 'utf8');
if (
  !validatorWorkflow.includes('  pull_request:\n')
  || validatorWorkflow.includes('pull_request_target:')
  || !validatorWorkflow.includes('github.event.pull_request.base.sha')
  || !validatorWorkflow.includes('persist-credentials: false')
  || !validatorWorkflow.includes('permissions:\n  contents: read')
) {
  throw new Error('Trusted head-bound catalog workflow contract is incomplete.');
}

const browserCode = await readFile('app.js', 'utf8');
const indexHtml = await readFile('index.html', 'utf8');
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

if (
  !browserCode.includes("String(link.geo || 'GLOBAL')")
  || !indexHtml.includes('placeholder="GLOBAL"')
) {
  throw new Error('New affiliate links must default to GLOBAL.');
}

if (
  !browserCode.includes('setAffiliateFormOpen(false)')
  || !indexHtml.includes('id="affiliate-create-button"')
  || !indexHtml.includes('id="affiliate-form" class="affiliate-form" aria-labelledby="affiliate-form-title" hidden')
) {
  throw new Error('Affiliate catalog must remain the primary view with an explicit form opener.');
}

if (
  !browserCode.includes('const AFFILIATE_PAGE_SIZE = 25')
  || !browserCode.includes('affiliateForm.checkValidity()')
  || !indexHtml.includes('id="affiliate-catalog-status"')
  || !indexHtml.includes('id="affiliate-pagination"')
  || !indexHtml.includes('id="affiliate-delete-button"')
) {
  throw new Error('Affiliate catalog UX and validation contract is incomplete.');
}

process.stdout.write('Static checks passed.\n');
