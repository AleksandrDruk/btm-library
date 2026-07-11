import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToBase64, createPasswordHash } from '../lib/crypto.js';
import { handleRequest } from '../worker/index.js';

async function environment() {
  return {
    ENVIRONMENT: 'test',
    ALLOWED_ORIGINS: 'https://example.test',
    PASSWORD_HASH: await createPasswordHash('test-only-password-1234567890'),
    SESSION_SECRET: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
    SESSION_VERSION: '1',
    SESSION_TTL_SECONDS: '1800',
    TURNSTILE_SECRET: 'test-secret',
    TURNSTILE_HOSTNAME: 'example.test',
    LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) },
    UPLOAD_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
}

const turnstileFetch = async () => Response.json({ success: true, action: 'btm_login', hostname: 'example.test' });

test('rejects requests from an untrusted origin', async () => {
  const env = await environment();
  const request = new Request('https://api.example.test/login', {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
    body: JSON.stringify({ password: 'test-only-password-1234567890', turnstile_token: 'token' }),
  });
  const response = await handleRequest(request, env, {}, turnstileFetch);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'origin_denied');
});

test('issues a short-lived session only for the correct password', async () => {
  const env = await environment();
  const wrong = await handleRequest(new Request('https://api.example.test/login', {
    method: 'POST',
    headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password', turnstile_token: 'token' }),
  }), env, {}, turnstileFetch);
  assert.equal(wrong.status, 401);

  const valid = await handleRequest(new Request('https://api.example.test/login', {
    method: 'POST',
    headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-only-password-1234567890', turnstile_token: 'token' }),
  }), env, {}, turnstileFetch);
  const body = await valid.json();
  assert.equal(valid.status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.token, 'string');
  assert.ok(body.token.length > 20);
});

test('rejects a Turnstile token issued for another hostname', async () => {
  const env = await environment();
  const response = await handleRequest(new Request('https://api.example.test/login', {
    method: 'POST',
    headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-only-password-1234567890', turnstile_token: 'token' }),
  }), env, {}, async () => Response.json({ success: true, action: 'btm_login', hostname: 'evil.example' }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'access_denied');
});

test('rate limiter denial returns 429 before password verification', async () => {
  const env = await environment();
  env.LOGIN_RATE_LIMITER = { limit: async () => ({ success: false }) };
  const response = await handleRequest(new Request('https://api.example.test/login', {
    method: 'POST',
    headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-only-password-1234567890', turnstile_token: 'token' }),
  }), env, {}, turnstileFetch);
  assert.equal(response.status, 429);
});

test('returns a safe error when the password verifier is unavailable', async () => {
  const env = await environment();
  env.PASSWORD_HASH = 'invalid-password-hash';
  const response = await handleRequest(new Request('https://api.example.test/login', {
    method: 'POST',
    headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-only-password-1234567890', turnstile_token: 'token' }),
  }), env, {}, turnstileFetch);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'password_verifier_error');
});

test('returns a safe error when session issuance is unavailable', async () => {
  const env = await environment();
  env.SESSION_SECRET = 'invalid-base64';
  const response = await handleRequest(new Request('https://api.example.test/login', {
    method: 'POST',
    headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-only-password-1234567890', turnstile_token: 'token' }),
  }), env, {}, turnstileFetch);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'session_issuer_unavailable');
});
