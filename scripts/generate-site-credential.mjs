#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { deriveAffiliateSiteSecret } from '../lib/crypto.js';

const secretsPath = process.argv[2] || 'secrets.production.json';
const randomId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('');
const siteId = `site-${randomId}`;

let secrets;
try {
  secrets = JSON.parse(await readFile(secretsPath, 'utf8'));
} catch {
  throw new Error(`Could not read a valid secrets JSON file: ${secretsPath}`);
}

if (typeof secrets.AFFILIATE_READ_MASTER_SECRET !== 'string') {
  throw new Error('AFFILIATE_READ_MASTER_SECRET is missing from the secrets file.');
}

const siteSecret = await deriveAffiliateSiteSecret(secrets.AFFILIATE_READ_MASTER_SECRET, siteId);
process.stdout.write(`${JSON.stringify({
  site_id: siteId,
  site_secret: siteSecret,
}, null, 2)}\n`);
