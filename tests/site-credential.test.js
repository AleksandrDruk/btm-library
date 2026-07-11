import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { bytesToBase64 } from '../lib/crypto.js';

const execFileAsync = promisify(execFile);

test('site credential generator accepts the production secret contract and emits an opaque id', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'btm-site-credential-'));
  const secretsPath = path.join(directory, 'secrets.production.json');
  try {
    await writeFile(secretsPath, JSON.stringify({
      AFFILIATE_READ_MASTER_SECRET: bytesToBase64(crypto.getRandomValues(new Uint8Array(48))),
    }), { mode: 0o600 });
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/generate-site-credential.mjs'),
      secretsPath,
    ], { cwd: process.cwd() });
    const credential = JSON.parse(stdout);

    assert.match(credential.site_id, /^site-[a-f0-9]{24}$/);
    assert.equal(Buffer.from(credential.site_secret, 'base64').byteLength, 32);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
