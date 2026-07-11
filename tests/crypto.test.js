import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToBase64,
  createPasswordHash,
  createSessionToken,
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
