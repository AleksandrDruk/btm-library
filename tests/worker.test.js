import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  bytesToBase64,
  createAffiliateSiteSignature,
  createPasswordHash,
  createSessionToken,
  deriveAffiliateSiteSecret,
} from '../lib/crypto.js';
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
    AFFILIATE_READ_MASTER_SECRET: bytesToBase64(crypto.getRandomValues(new Uint8Array(48))),
    AFFILIATE_READ_RATE_LIMITER: { limit: async () => ({ success: true }) },
    AFFILIATE_WRITE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    AFFILIATE_NONCE_STORE: nonceNamespace(),
  };
}

function nonceNamespace() {
  const accepted = new Set();
  return {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: async () => {
        if (accepted.has(id)) {
          return new Response(null, { status: 409 });
        }
        accepted.add(id);
        return new Response(null, { status: 204 });
      },
    }),
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

test('enforces JSON limits in UTF-8 bytes when Content-Length is unavailable', async () => {
  const env = await environment();
  const response = await handleRequest(new Request('https://api.example.test/login', {
    method: 'POST',
    headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'я'.repeat(5000), turnstile_token: 'token' }),
  }), env, {}, async () => {
    throw new Error('Turnstile must not be called for an oversized request');
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'request_too_large');
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
  env.PASSWORD_HASH = 'dummy';
  const response = await handleRequest(new Request('https://api.example.test/login', {
    method: 'POST',
    headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ['pass' + 'word']: 'dummy', turnstile_token: 'token' }),
  }), env, {}, turnstileFetch);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'password_verifier_error');
});

test('returns a safe error when session issuance is unavailable', async () => {
  const env = await environment();
  env.SESSION_SECRET = 'dummy';
  const response = await handleRequest(new Request('https://api.example.test/login', {
    method: 'POST',
    headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ['pass' + 'word']: 'test-only-password-1234567890', turnstile_token: 'token' }),
  }), env, {}, turnstileFetch);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'session_issuer_unavailable');
});

test('health reports readiness only when both repository boundaries are configured', async () => {
  const env = await environment();
  const incomplete = await handleRequest(new Request('https://api.example.test/health'), env);
  const incompleteBody = await incomplete.json();
  assert.equal(incompleteBody.ready, false);
  assert.equal(incompleteBody.logo_ready, false);
  assert.equal(incompleteBody.affiliate_ready, false);

  Object.assign(env, {
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'logo-key',
    GITHUB_OWNER: 'AleksandrDruk',
    GITHUB_REPO: 'btm-library',
    GITHUB_BASE_BRANCH: 'main',
    AFFILIATE_GITHUB_APP_ID: '2',
    AFFILIATE_GITHUB_APP_PRIVATE_KEY: 'affiliate-key',
    AFFILIATE_GITHUB_OWNER: 'AleksandrDruk',
    AFFILIATE_GITHUB_REPO: 'btm-affiliate-library',
    AFFILIATE_GITHUB_BASE_BRANCH: 'main',
  });
  const ready = await handleRequest(new Request('https://api.example.test/health'), env);
  const readyBody = await ready.json();
  assert.equal(readyBody.ready, true);
  assert.equal(readyBody.logo_ready, true);
  assert.equal(readyBody.affiliate_ready, true);
});

test('affiliate proposal endpoint creates a PR without writing to the base branch', async () => {
  const env = await environment();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(env, {
    AFFILIATE_GITHUB_APP_ID: String(Date.now() + 3),
    AFFILIATE_GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    AFFILIATE_GITHUB_OWNER: 'AleksandrDruk',
    AFFILIATE_GITHUB_REPO: 'btm-affiliate-library',
    AFFILIATE_GITHUB_BASE_BRANCH: 'main',
  });
  const sessionToken = await createSessionToken(env.SESSION_SECRET, 300, env.SESSION_VERSION);
  const catalog = { schema_version: 1, catalog_version: 1, items: [] };
  let treeBody = null;
  let refBody = null;

  const fetchMock = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/installation')) return Response.json({ id: 93 });
    if (pathname === '/app/installations/93/access_tokens') {
      assert.deepEqual(JSON.parse(options.body), {
        repositories: ['btm-affiliate-library'],
        permissions: { contents: 'write', pull_requests: 'write' },
      });
      return Response.json({ token: 'affiliate-write-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'affiliate-base' } });
    if (pathname.endsWith('/git/commits/affiliate-base')) return Response.json({ tree: { sha: 'affiliate-tree' } });
    if (pathname.endsWith('/contents/catalog.json')) {
      return Response.json({ content: Buffer.from(JSON.stringify(catalog)).toString('base64') });
    }
    if (pathname.endsWith('/git/blobs')) return Response.json({ sha: 'affiliate-catalog-blob' });
    if (pathname.endsWith('/git/trees')) {
      treeBody = JSON.parse(options.body);
      return Response.json({ sha: 'affiliate-new-tree' });
    }
    if (pathname.endsWith('/git/commits')) return Response.json({ sha: 'affiliate-new-commit' });
    if (pathname.endsWith('/git/refs')) {
      refBody = JSON.parse(options.body);
      return Response.json({ ref: refBody.ref }, { status: 201 });
    }
    if (pathname.endsWith('/pulls')) {
      return Response.json({
        number: 12,
        html_url: 'https://github.com/AleksandrDruk/btm-affiliate-library/pull/12',
      }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };

  const response = await handleRequest(new Request('https://api.example.test/affiliate-catalog/propose', {
    method: 'POST',
    headers: {
      Origin: 'https://example.test',
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      catalog_version: 1,
      operations: [{
        mode: 'new',
        asset_id: '',
        brand: 'Vegas Hero',
        destination_url: 'https://tracking.example.test/click?campaign=42',
        tags: 'vegas hero',
      }],
    }),
  }), env, {}, fetchMock);
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.pull_request.number, 12);
  assert.match(refBody.ref, /^refs\/heads\/affiliate-links\//);
  assert.deepEqual(treeBody.tree, [{
    path: 'catalog.json',
    mode: '100644',
    type: 'blob',
    sha: 'affiliate-catalog-blob',
  }]);
});

test('rejects an expired signed WordPress catalog request before repository access', async () => {
  const env = await environment();
  const siteId = 'example.test';
  const timestamp = Math.floor(Date.now() / 1000) - 600;
  const nonce = 'abcdefghijklmnopqrstuv';
  const siteSecret = await deriveAffiliateSiteSecret(env.AFFILIATE_READ_MASTER_SECRET, siteId);
  const signature = await createAffiliateSiteSignature(siteSecret, siteId, timestamp, nonce);
  const response = await handleRequest(new Request('https://api.example.test/affiliate-catalog/read', {
    method: 'POST',
    headers: {
      'X-BTM-Site': siteId,
      'X-BTM-Timestamp': String(timestamp),
      'X-BTM-Nonce': nonce,
      'X-BTM-Signature': signature,
    },
  }), env, {}, async () => {
    throw new Error('GitHub must not be called');
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'affiliate_auth_expired');
});

test('serves the private affiliate catalog to a correctly signed WordPress request', async () => {
  const env = await environment();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(env, {
    AFFILIATE_GITHUB_APP_ID: String(Date.now() + 2),
    AFFILIATE_GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    AFFILIATE_GITHUB_OWNER: 'AleksandrDruk',
    AFFILIATE_GITHUB_REPO: 'btm-affiliate-library',
    AFFILIATE_GITHUB_BASE_BRANCH: 'main',
  });
  const catalog = {
    schema_version: 1,
    catalog_version: 3,
    items: [{
      id: 'vegas-hero',
      brand: 'Vegas Hero',
      destination_url: 'https://tracking.example.test/click?campaign=42',
      version: 1,
      tags: ['vegas hero'],
    }],
  };
  const siteId = 'example.test';
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = 'abcdefghijklmnopqrstuv';
  const siteSecret = await deriveAffiliateSiteSecret(env.AFFILIATE_READ_MASTER_SECRET, siteId);
  const signature = await createAffiliateSiteSignature(siteSecret, siteId, timestamp, nonce);

  const fetchMock = async (url, options = {}) => {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    if (pathname.endsWith('/installation')) return Response.json({ id: 62 });
    if (pathname === '/app/installations/62/access_tokens') {
      assert.deepEqual(JSON.parse(options.body).permissions, { contents: 'read' });
      return Response.json({ token: 'affiliate-read-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'affiliate-base' } });
    if (pathname.endsWith('/git/commits/affiliate-base')) return Response.json({ tree: { sha: 'affiliate-tree' } });
    if (pathname.endsWith('/contents/catalog.json')) {
      return Response.json({ content: Buffer.from(JSON.stringify(catalog)).toString('base64') });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };

  const response = await handleRequest(new Request('https://api.example.test/affiliate-catalog/read', {
    method: 'POST',
    headers: {
      'X-BTM-Site': siteId,
      'X-BTM-Timestamp': String(timestamp),
      'X-BTM-Nonce': nonce,
      'X-BTM-Signature': signature,
    },
  }), env, {}, fetchMock);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.catalog, catalog);

  const replay = await handleRequest(new Request('https://api.example.test/affiliate-catalog/read', {
    method: 'POST',
    headers: {
      'X-BTM-Site': siteId,
      'X-BTM-Timestamp': String(timestamp),
      'X-BTM-Nonce': nonce,
      'X-BTM-Signature': signature,
    },
  }), env, {}, async () => {
    throw new Error('A replay must be rejected before GitHub access');
  });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).code, 'affiliate_replay_rejected');
});
