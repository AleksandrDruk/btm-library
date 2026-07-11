import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToBase64,
  createAffiliateSiteSignature,
  createPasswordHash,
  createSessionToken,
  deriveAffiliateSiteSecret,
  verifyAffiliateSiteSignature,
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

test('affiliate site credentials accept the 48-byte generator contract and stay isolated by site id', async () => {
  const master = bytesToBase64(crypto.getRandomValues(new Uint8Array(48)));
  const firstSecret = await deriveAffiliateSiteSecret(master, 'example.test');
  const secondSecret = await deriveAffiliateSiteSecret(master, 'other.example');
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = 'abcdefghijklmnopqrstuv';
  const signature = await createAffiliateSiteSignature(firstSecret, 'example.test', timestamp, nonce);

  assert.notEqual(firstSecret, secondSecret);
  assert.equal(
    await verifyAffiliateSiteSignature(signature, firstSecret, 'example.test', timestamp, nonce),
    true,
  );
  assert.equal(
    await verifyAffiliateSiteSignature(signature, secondSecret, 'example.test', timestamp, nonce),
    false,
  );
});
