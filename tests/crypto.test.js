import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToBase64,
  createPasswordHash,
  createSessionToken,
  sha256Hex,
  verifyPassword,
  verifySessionToken,
} from '../lib/crypto.js';

test('password hash accepts the right password and rejects a wrong one', async () => {
  const hash = await createPasswordHash('test-only-password-1234567890');
  assert.match(hash, /^pbkdf2-sha256\$100000\$/);
  assert.equal(await verifyPassword('test-only-password-1234567890', hash), true);
  assert.equal(await verifyPassword('wrong-password', hash), false);
});
test('password hash rejects iterations unsupported by Cloudflare Workers', async () => {
  await assert.rejects(
    createPasswordHash('test-only-password-1234567890', 100_001),
    /exactly 100000 iterations/,
  );
});
test('session tokens are signed, versioned and short-lived', async () => {
  const secret = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  const token = await createSessionToken(secret, 600, '4');
  const payload = await verifySessionToken(token, secret, '4');
  assert.equal(payload.v, '4');
  assert.equal(await verifySessionToken(`${token}x`, secret, '4'), null);
  assert.equal(await verifySessionToken(token, secret, '5'), null);
});

test('SHA-256 helper hashes exact bytes for browser and Worker catalog paths', async () => {
  assert.equal(
    await sha256Hex(new Uint8Array([97, 98, 99])),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
