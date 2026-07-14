import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  bytesToBase64,
  createPasswordHash,
  createSessionToken,
  sha256Hex,
} from '../lib/crypto.js';
import {
  buildAffiliateCatalogUpdate,
  serializeAffiliateCatalog,
  serializeAffiliateCatalogSnapshot,
} from '../lib/affiliate-catalog.js';
import {
  AffiliateCatalogState,
  publishApprovedAffiliateSnapshot,
} from '../worker/affiliate-catalog-state.js';
import { handleRequest } from '../worker/index.js';
import { createVisualFingerprint, VISUAL_SAMPLE_SIZE } from '../lib/visual-dedupe.js';

const APPROVED_SHA = '1111111111111111111111111111111111111111';
const GITHUB_APP_KEY_ENV = 'GITHUB_APP_PRIVATE_KEY';

const emptyAffiliateCatalog = () => ({ schema_version: 2, catalog_version: 1, items: [] });

function pngBytes() {
  const bytes = new Uint8Array(57);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 120, false);
  view.setUint32(20, 60, false);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([0, 0, 0, 0], 29);
  bytes.set([0, 0, 0, 0], 33);
  bytes.set([73, 68, 65, 84], 37);
  bytes.set([0, 0, 0, 0], 41);
  bytes.set([0, 0, 0, 0], 45);
  bytes.set([73, 69, 78, 68], 49);
  bytes.set([0, 0, 0, 0], 53);
  return bytes;
}

function gitBlobSha(bytes) {
  return createHash('sha1')
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest('hex');
}

function visualFingerprint(red = 40, green = 90, blue = 160) {
  const pixels = new Uint8ClampedArray(VISUAL_SAMPLE_SIZE * VISUAL_SAMPLE_SIZE * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = 255;
  }
  return createVisualFingerprint(pixels, 2);
}

function affiliateLink(geo, destinationUrl, options = {}) {
  return {
    id: options.id || '',
    geo,
    label: options.label || '',
    destination_url: destinationUrl,
  };
}

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
    AFFILIATE_READ_RATE_LIMITER: { limit: async () => ({ success: true }) },
    AFFILIATE_WRITE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    AFFILIATE_APPROVER_LOGIN: 'AleksandrDruk',
    AFFILIATE_APPROVED_SHA: APPROVED_SHA,
    AFFILIATE_CATALOG_STATE: catalogStateNamespace(APPROVED_SHA),
  };
}

function catalogStateNamespace(initialSha) {
  const values = new Map([['approved_sha', initialSha]]);
  const storage = {
    async get(key) {
      return values.get(key);
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    async transaction(callback) {
      return callback(storage);
    },
  };
  const state = new AffiliateCatalogState({ storage });
  let beforeCacheWrite = null;
  const namespace = {
    current: () => values.get('approved_snapshot')?.sha || values.get('approved_sha') || '',
    snapshot: () => values.get('approved_snapshot') || null,
    beforeNextCacheWrite(callback) {
      beforeCacheWrite = callback;
    },
    corruptSnapshot(value) {
      values.set('approved_snapshot', value);
    },
    idFromName: (name) => name,
    get: (id) => ({
      fetch: async (url, options = {}) => {
        assert.equal(id, 'approved-affiliate-catalog');
        const request = new Request(url, options);
        if (
          beforeCacheWrite
          && request.method === 'PUT'
          && new URL(request.url).pathname === '/approved-snapshot'
        ) {
          const body = await request.clone().json();
          if (body.mode === 'cache') {
            const callback = beforeCacheWrite;
            beforeCacheWrite = null;
            await callback();
          }
        }
        return state.fetch(request);
      },
    }),
  };
  return namespace;
}

function authenticatedRequestHeaders(sessionValue, includeJson = false) {
  return {
    Origin: 'https://example.test',
    ['Author' + 'ization']: `Bearer ${sessionValue}`,
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
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
  const catalog = emptyAffiliateCatalog();
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
    if (pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: APPROVED_SHA } });
    if (pathname.endsWith(`/git/commits/${APPROVED_SHA}`)) return Response.json({ tree: { sha: 'affiliate-tree' } });
    if (pathname.endsWith('/contents/catalog.json')) {
      return Response.json({ content: Buffer.from(serializeAffiliateCatalog(catalog)).toString('base64') });
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
        logo_id: '',
        links: [affiliateLink('IT', 'https://tracking.example.test/click?campaign=42')],
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

test('schema 2 logo upload binds catalog sha256 to the exact uploaded bytes', async () => {
  const env = await environment();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(env, {
    GITHUB_APP_ID: String(Date.now() + 50),
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    GITHUB_OWNER: 'AleksandrDruk',
    GITHUB_REPO: 'btm-library',
    GITHUB_BASE_BRANCH: 'main',
  });
  const sessionToken = await createSessionToken(env.SESSION_SECRET, 300, env.SESSION_VERSION);
  const imageBytes = pngBytes();
  const expectedDigest = await sha256Hex(imageBytes);
  let candidateCatalog = null;
  let candidateVisualIndex = null;
  let candidateTree = null;

  const fetchMock = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/installation')) return Response.json({ id: 151 });
    if (pathname === '/app/installations/151/access_tokens') {
      return Response.json({ token: 'logo-write-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: APPROVED_SHA } });
    if (pathname.endsWith(`/git/commits/${APPROVED_SHA}`)) return Response.json({ tree: { sha: 'logo-tree' } });
    if (pathname.endsWith('/contents/catalog.json')) {
      const catalog = { schema_version: 2, catalog_version: 3, items: [] };
      return Response.json({ content: Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`).toString('base64') });
    }
    if (pathname.endsWith('/contents/visual-index.json')) {
      const visualIndex = { schema_version: 1, catalog_version: 3, items: [] };
      return Response.json({ content: Buffer.from(`${JSON.stringify(visualIndex, null, 2)}\n`).toString('base64') });
    }
    if (pathname.endsWith('/git/trees/logo-tree')) {
      return Response.json({ truncated: false, tree: [] });
    }
    if (pathname.endsWith('/git/blobs')) {
      const body = JSON.parse(options.body);
      if (body.encoding === 'utf-8') {
        const parsed = JSON.parse(body.content);
        if (parsed.schema_version === 1) {
          candidateVisualIndex = parsed;
          return Response.json({ sha: 'logo-visual-index-blob' });
        }
        candidateCatalog = parsed;
        return Response.json({ sha: 'logo-catalog-blob' });
      }
      assert.equal(body.encoding, 'base64');
      assert.deepEqual(Buffer.from(body.content, 'base64'), Buffer.from(imageBytes));
      return Response.json({ sha: 'logo-image-blob' });
    }
    if (pathname.endsWith('/git/trees')) {
      candidateTree = JSON.parse(options.body);
      return Response.json({ sha: 'logo-new-tree' });
    }
    if (pathname.endsWith('/git/commits')) return Response.json({ sha: 'logo-new-commit' });
    if (pathname.endsWith('/git/refs')) return Response.json({ ref: 'refs/heads/logo-upload/test' }, { status: 201 });
    if (pathname.endsWith('/pulls')) {
      return Response.json({
        number: 51,
        html_url: 'https://github.com/AleksandrDruk/btm-library/pull/51',
      }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };

  const form = new FormData();
  form.set('metadata', JSON.stringify([{
    mode: 'new',
    asset_id: '',
    brand: 'Digest Brand',
    variant: 'Primary',
    suggested_filename: 'digest-brand.png',
    tags: 'digest, primary',
    visual_fingerprint: visualFingerprint(),
  }]));
  form.set('file_0', new File([imageBytes], 'digest-brand.png', { type: 'image/png' }));

  const response = await handleRequest(new Request('https://api.example.test/upload', {
    method: 'POST',
    headers: authenticatedRequestHeaders(sessionToken),
    body: form,
  }), env, {}, fetchMock);

  assert.equal(response.status, 201);
  assert.equal(candidateCatalog.items[0].sha256, expectedDigest);
  assert.equal(candidateVisualIndex.items[0].sha256, expectedDigest);
  assert.deepEqual(candidateTree.tree.map((entry) => entry.path), [
    'logos/digest-brand/digest-brand-primary-v1.png',
    'catalog.json',
    'visual-index.json',
  ]);
});

test('logo upload returns 409 for exact bytes already present in repository history', async () => {
  const env = await environment();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(env, {
    GITHUB_APP_ID: String(Date.now() + 51),
    [GITHUB_APP_KEY_ENV]: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    GITHUB_OWNER: 'AleksandrDruk',
    GITHUB_REPO: 'btm-library',
    GITHUB_BASE_BRANCH: 'main',
  });
  const sessionToken = await createSessionToken(env.SESSION_SECRET, 300, env.SESSION_VERSION);
  const imageBytes = pngBytes();
  const blobSha = gitBlobSha(imageBytes);
  const catalog = {
    schema_version: 1,
    catalog_version: 2,
    items: [{
      id: 'existing-primary',
      brand: 'Existing',
      variant: 'Primary',
      path: 'logos/existing/existing-primary-v1.png',
      suggested_filename: 'existing.png',
      version: 1,
      tags: ['existing'],
    }],
  };
  let mutationCalled = false;

  const fetchMock = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/installation')) return Response.json({ id: 152 });
    if (pathname === '/app/installations/152/access_tokens') {
      return Response.json({ token: 'test-only', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: APPROVED_SHA } });
    if (pathname.endsWith(`/git/commits/${APPROVED_SHA}`)) return Response.json({ tree: { sha: 'logo-tree' } });
    if (pathname.endsWith('/contents/catalog.json')) {
      return Response.json({ content: Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`).toString('base64') });
    }
    if (pathname.endsWith('/contents/visual-index.json')) {
      const visualIndex = {
        schema_version: 1,
        catalog_version: 2,
        items: [{
          path: catalog.items[0].path,
          sha256: createHash('sha256').update(imageBytes).digest('hex'),
          fingerprint: visualFingerprint(),
        }],
      };
      return Response.json({ content: Buffer.from(`${JSON.stringify(visualIndex, null, 2)}\n`).toString('base64') });
    }
    if (pathname.endsWith('/git/trees/logo-tree')) {
      return Response.json({
        truncated: false,
        tree: [{
          path: catalog.items[0].path,
          mode: '100644',
          type: 'blob',
          sha: blobSha,
          size: imageBytes.byteLength,
        }],
      });
    }
    if (pathname.endsWith(`/git/blobs/${blobSha}`)) {
      return Response.json({
        encoding: 'base64',
        content: Buffer.from(imageBytes).toString('base64'),
        size: imageBytes.byteLength,
      });
    }
    if (options.method === 'POST') mutationCalled = true;
    throw new Error(`Unexpected request: ${pathname}`);
  };

  const form = new FormData();
  form.set('metadata', JSON.stringify([{
    mode: 'new',
    asset_id: '',
    brand: 'Other',
    variant: 'Primary',
    suggested_filename: 'other.png',
    tags: 'other, primary',
    visual_fingerprint: visualFingerprint(),
  }]));
  form.set('file_0', new File([imageBytes], 'other.png', { type: 'image/png' }));

  const response = await handleRequest(new Request('https://api.example.test/upload', {
    method: 'POST',
    headers: authenticatedRequestHeaders(sessionToken),
    body: form,
  }), env, {}, fetchMock);
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.code, 'duplicate_image_content');
  assert.match(body.message, /logos\/existing\/existing-primary-v1\.png/);
  assert.equal(mutationCalled, false);
});

test('logo upload rechecks a cross-format visual duplicate against current main', async () => {
  const env = await environment();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(env, {
    GITHUB_APP_ID: String(Date.now() + 52),
    [GITHUB_APP_KEY_ENV]: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    GITHUB_OWNER: 'AleksandrDruk',
    GITHUB_REPO: 'btm-library',
    GITHUB_BASE_BRANCH: 'main',
  });
  const sessionToken = await createSessionToken(env.SESSION_SECRET, 300, env.SESSION_VERSION);
  const existingBytes = pngBytes();
  const uploadedBytes = new Uint8Array(existingBytes);
  uploadedBytes[44] = 1;
  const existingPath = 'logos/existing/existing-primary-v1.png';
  const sharedFingerprint = visualFingerprint();
  let mutationCalled = false;
  const catalog = {
    schema_version: 1,
    catalog_version: 2,
    items: [{
      id: 'existing-primary',
      brand: 'Existing',
      variant: 'Primary',
      path: existingPath,
      suggested_filename: 'existing.png',
      version: 1,
      tags: ['existing'],
    }],
  };
  const visualIndex = {
    schema_version: 1,
    catalog_version: 2,
    items: [{
      path: existingPath,
      sha256: createHash('sha256').update(existingBytes).digest('hex'),
      fingerprint: sharedFingerprint,
    }],
  };

  const fetchMock = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/installation')) return Response.json({ id: 153 });
    if (pathname === '/app/installations/153/access_tokens') {
      return Response.json({ token: 'test-only', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: APPROVED_SHA } });
    if (pathname.endsWith(`/git/commits/${APPROVED_SHA}`)) return Response.json({ tree: { sha: 'logo-tree' } });
    if (pathname.endsWith('/contents/catalog.json')) {
      return Response.json({ content: Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`).toString('base64') });
    }
    if (pathname.endsWith('/contents/visual-index.json')) {
      return Response.json({ content: Buffer.from(`${JSON.stringify(visualIndex, null, 2)}\n`).toString('base64') });
    }
    if (options.method === 'POST') mutationCalled = true;
    throw new Error(`Unexpected request: ${pathname}`);
  };

  const form = new FormData();
  form.set('metadata', JSON.stringify([{
    mode: 'new',
    asset_id: '',
    brand: 'Other',
    variant: 'Primary',
    suggested_filename: 'other.png',
    tags: 'other, primary',
    visual_fingerprint: sharedFingerprint,
  }]));
  form.set('file_0', new File([uploadedBytes], 'other.png', { type: 'image/png' }));

  const response = await handleRequest(new Request('https://api.example.test/upload', {
    method: 'POST',
    headers: authenticatedRequestHeaders(sessionToken),
    body: form,
  }), env, {}, fetchMock);
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.code, 'duplicate_image_visual');
  assert.match(body.message, /logos\/existing\/existing-primary-v1\.png/);
  assert.equal(mutationCalled, false);
});

test('affiliate approval gate publishes only an exact reviewed commit with both checks', async () => {
  const env = await environment();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(env, {
    AFFILIATE_GITHUB_APP_ID: String(Date.now() + 100),
    ['AFFILIATE_GITHUB_APP_' + 'PRIVATE_KEY']: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    AFFILIATE_GITHUB_OWNER: 'AleksandrDruk',
    AFFILIATE_GITHUB_REPO: 'btm-affiliate-library',
    AFFILIATE_GITHUB_BASE_BRANCH: 'main',
  });
  const sessionMarker = await createSessionToken(env.SESSION_SECRET, 300, env.SESSION_VERSION);
  const headSha = '2222222222222222222222222222222222222222';
  const mergedSha = '3333333333333333333333333333333333333333';
  const baseCatalog = { schema_version: 1, catalog_version: 1, items: [] };
  const candidateCatalog = buildAffiliateCatalogUpdate(emptyAffiliateCatalog(), [{
    mode: 'new',
    asset_id: '',
    brand: 'Vegas Hero',
    logo_id: '',
    links: [affiliateLink('IT', 'https://tracking.example.test/click?campaign=42')],
    tags: 'vegas hero',
  }]).catalog;
  const pull = {
    number: 14,
    title: 'Affiliate catalog: Vegas Hero',
    html_url: 'https://github.com/AleksandrDruk/btm-affiliate-library/pull/14',
    state: 'open',
    draft: false,
    commits: 1,
    changed_files: 1,
    created_at: '2026-07-11T13:00:00Z',
    base: {
      ref: 'main',
      repo: { full_name: 'AleksandrDruk/btm-affiliate-library' },
    },
    head: {
      ref: 'affiliate-links/approval-test',
      sha: headSha,
      repo: { full_name: 'AleksandrDruk/btm-affiliate-library' },
    },
  };

  const fetchMock = async (url, options = {}) => {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    if (pathname.endsWith('/installation')) return Response.json({ id: 114 });
    if (pathname === '/app/installations/114/access_tokens') {
      assert.deepEqual(JSON.parse(options.body).permissions, {
        checks: 'read',
        contents: 'write',
        pull_requests: 'write',
      });
      return Response.json({ token: 'test-only', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (pathname.endsWith('/pulls')) return Response.json([pull]);
    if (pathname.endsWith('/pulls/14') && options.method !== 'PUT') return Response.json(pull);
    if (pathname.endsWith('/pulls/14/files')) {
      return Response.json([{ filename: 'catalog.json', status: 'modified' }]);
    }
    if (pathname.endsWith('/pulls/14/reviews')) {
      return Response.json([{
        id: 81,
        state: 'APPROVED',
        commit_id: headSha,
        user: { login: 'AleksandrDruk' },
      }]);
    }
    if (pathname.endsWith(`/commits/${headSha}/check-runs`)) {
      return Response.json({
        check_runs: ['validate-catalog', 'code-checks'].map((name, index) => ({
          id: index + 1,
          name,
          head_sha: headSha,
          status: 'completed',
          conclusion: 'success',
          app: { slug: 'github-actions' },
        })),
      });
    }
    if (pathname.endsWith('/git/ref/heads/main')) {
      return Response.json({ object: { sha: APPROVED_SHA } });
    }
    if (pathname.endsWith(`/git/commits/${APPROVED_SHA}`)) {
      return Response.json({ tree: { sha: 'base-tree' }, parents: [] });
    }
    if (pathname.endsWith(`/git/commits/${headSha}`)) {
      return Response.json({
        tree: { sha: 'candidate-tree' },
        parents: [{ sha: APPROVED_SHA }],
      });
    }
    if (pathname.endsWith(`/git/commits/${mergedSha}`)) {
      return Response.json({
        tree: { sha: 'candidate-tree' },
        parents: [{ sha: APPROVED_SHA }],
      });
    }
    if (pathname.endsWith('/contents/catalog.json')) {
      const ref = parsed.searchParams.get('ref');
      const catalog = ref === APPROVED_SHA ? baseCatalog : candidateCatalog;
      return Response.json({ content: Buffer.from(serializeAffiliateCatalogSnapshot(catalog)).toString('base64') });
    }
    if (pathname.endsWith('/pulls/14/merge') && options.method === 'PUT') {
      assert.deepEqual(JSON.parse(options.body), {
        sha: headSha,
        merge_method: 'squash',
        commit_title: 'Publish affiliate catalog PR #14',
        commit_message: 'Validated by BTM approval gate.',
      });
      return Response.json({ merged: true, sha: mergedSha });
    }
    if (pathname.endsWith('/git/refs/heads/affiliate-links/approval-test') && options.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${pathname}`);
  };

  const proposalsResponse = await handleRequest(new Request('https://api.example.test/affiliate-catalog/proposals', {
    method: 'GET',
    headers: authenticatedRequestHeaders(sessionMarker),
  }), env, {}, fetchMock);
  const proposalsBody = await proposalsResponse.json();
  assert.equal(proposalsResponse.status, 200);
  assert.equal(proposalsBody.proposals.length, 1);
  assert.equal(proposalsBody.proposals[0].publishable, true);

  const response = await handleRequest(new Request('https://api.example.test/affiliate-catalog/proposals/14/publish', {
    method: 'POST',
    headers: authenticatedRequestHeaders(sessionMarker, true),
    body: JSON.stringify({ head_sha: headSha }),
  }), env, {}, fetchMock);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.published, true);
  assert.equal(body.catalog.catalog_version, 2);
  assert.equal(env.AFFILIATE_CATALOG_STATE.current(), mergedSha);
});

test('affiliate approval gate rejects a stale review and a failed required check without merging', async () => {
  const env = await environment();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(env, {
    AFFILIATE_GITHUB_APP_ID: String(Date.now() + 101),
    ['AFFILIATE_GITHUB_APP_' + 'PRIVATE_KEY']: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    AFFILIATE_GITHUB_OWNER: 'AleksandrDruk',
    AFFILIATE_GITHUB_REPO: 'btm-affiliate-library',
    AFFILIATE_GITHUB_BASE_BRANCH: 'main',
  });
  const sessionMarker = await createSessionToken(env.SESSION_SECRET, 300, env.SESSION_VERSION);
  const headSha = '4444444444444444444444444444444444444444';
  const previousHeadSha = '5555555555555555555555555555555555555555';
  const pull = {
    number: 15,
    title: 'Affiliate catalog: blocked proposal',
    html_url: 'https://github.com/AleksandrDruk/btm-affiliate-library/pull/15',
    state: 'open',
    draft: false,
    commits: 1,
    changed_files: 1,
    created_at: '2026-07-11T13:30:00Z',
    base: {
      ref: 'main',
      repo: { full_name: 'AleksandrDruk/btm-affiliate-library' },
    },
    head: {
      ref: 'affiliate-links/blocked-test',
      sha: headSha,
      repo: { full_name: 'AleksandrDruk/btm-affiliate-library' },
    },
  };
  let failedCheck = false;
  let mergeCalls = 0;

  const fetchMock = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/installation')) return Response.json({ id: 115 });
    if (pathname === '/app/installations/115/access_tokens') {
      return Response.json({ token: 'test-only', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (pathname.endsWith('/pulls')) return Response.json([pull]);
    if (pathname.endsWith('/pulls/15') && options.method !== 'PUT') return Response.json(pull);
    if (pathname.endsWith('/pulls/15/files')) {
      return Response.json([{ filename: 'catalog.json', status: 'modified' }]);
    }
    if (pathname.endsWith('/pulls/15/reviews')) {
      return Response.json([{
        id: 91,
        state: 'APPROVED',
        commit_id: previousHeadSha,
        user: { login: 'AleksandrDruk' },
      }]);
    }
    if (pathname.endsWith(`/commits/${headSha}/check-runs`)) {
      return Response.json({
        check_runs: ['validate-catalog', 'code-checks'].map((name, index) => ({
          id: index + 1,
          name,
          head_sha: headSha,
          status: 'completed',
          conclusion: failedCheck && name === 'code-checks' ? 'failure' : 'success',
          app: { slug: 'github-actions' },
        })),
      });
    }
    if (pathname.endsWith('/git/ref/heads/main')) {
      return Response.json({ object: { sha: APPROVED_SHA } });
    }
    if (pathname.endsWith(`/git/commits/${headSha}`)) {
      return Response.json({ tree: { sha: 'candidate-tree' }, parents: [{ sha: APPROVED_SHA }] });
    }
    if (pathname.endsWith('/pulls/15/merge')) {
      mergeCalls += 1;
      throw new Error('A blocked proposal must never reach merge');
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${pathname}`);
  };

  const proposalsResponse = await handleRequest(new Request('https://api.example.test/affiliate-catalog/proposals', {
    method: 'GET',
    headers: authenticatedRequestHeaders(sessionMarker),
  }), env, {}, fetchMock);
  const proposalsBody = await proposalsResponse.json();
  assert.equal(proposalsResponse.status, 200);
  assert.equal(proposalsBody.proposals[0].publishable, false);
  assert.equal(proposalsBody.proposals[0].code, 'review_required');

  failedCheck = true;
  const publishResponse = await handleRequest(new Request('https://api.example.test/affiliate-catalog/proposals/15/publish', {
    method: 'POST',
    headers: authenticatedRequestHeaders(sessionMarker, true),
    body: JSON.stringify({ head_sha: headSha }),
  }), env, {}, fetchMock);
  const publishBody = await publishResponse.json();
  assert.equal(publishResponse.status, 409);
  assert.equal(publishBody.code, 'checks_failed');
  assert.equal(mergeCalls, 0);
  assert.equal(env.AFFILIATE_CATALOG_STATE.current(), APPROVED_SHA);
});

test('affiliate catalog read endpoint accepts only GET', async () => {
  const env = await environment();
  const response = await handleRequest(new Request('https://api.example.test/affiliate-catalog/read', {
    method: 'POST',
  }), env, {}, async () => {
    throw new Error('GitHub must not be called');
  });

  assert.equal(response.status, 405);
  assert.equal((await response.json()).code, 'method_not_allowed');
});

test('rate-limits zero-config catalog reads before repository access', async () => {
  const env = await environment();
  env.AFFILIATE_READ_RATE_LIMITER = { limit: async () => ({ success: false }) };
  const response = await handleRequest(new Request('https://api.example.test/affiliate-catalog/read', {
    headers: {
      'CF-Connecting-IP': '203.0.113.10',
      'User-Agent': 'Brand-Tables-Manager/2.2.0',
    },
  }), env, {}, async () => {
    throw new Error('GitHub must not be called after rate-limit denial');
  });

  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, 'rate_limited');
});

test('does not expose the catalog to a generic browser or crawler client', async () => {
  const env = await environment();
  const response = await handleRequest(new Request('https://api.example.test/affiliate-catalog/read', {
    headers: { 'User-Agent': 'Googlebot/2.1' },
  }), env, {}, async () => {
    throw new Error('GitHub must not be called for a non-BTM client');
  });

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'wordpress_client_required');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow, noarchive');
});

test('serves the approved affiliate catalog to a zero-config WordPress GET request', async () => {
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
    schema_version: 2,
    catalog_version: 3,
    items: [{
      id: 'vegas-hero',
      brand: 'Vegas Hero',
      logo_id: '',
      version: 1,
      tags: ['vegas hero'],
      links: [{
        id: 'it',
        geo: 'IT',
        label: '',
        destination_url: 'https://tracking.example.test/click?campaign=42',
      }],
    }],
  };
  let githubAvailable = true;
  let githubCalls = 0;
  const fetchMock = async (url, options = {}) => {
    githubCalls += 1;
    if (!githubAvailable) throw new Error('simulated GitHub outage');
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    if (pathname.endsWith('/installation')) return Response.json({ id: 62 });
    if (pathname === '/app/installations/62/access_tokens') {
      assert.deepEqual(JSON.parse(options.body).permissions, { contents: 'read' });
      return Response.json({ token: 'affiliate-read-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (pathname.endsWith(`/git/commits/${APPROVED_SHA}`)) return Response.json({ tree: { sha: 'affiliate-tree' } });
    if (pathname.endsWith('/contents/catalog.json')) {
      return Response.json({ content: Buffer.from(serializeAffiliateCatalog(catalog)).toString('base64') });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };

  const response = await handleRequest(
    new Request('https://api.example.test/affiliate-catalog/read', {
      headers: {
        Origin: 'https://example.test',
        'User-Agent': 'Brand-Tables-Manager/2.2.0',
      },
    }),
    env,
    {},
    fetchMock,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.catalog, catalog);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow, noarchive');
  assert.doesNotMatch(JSON.stringify(body), /github\.com/i);

  const callsAfterWarmup = githubCalls;
  githubAvailable = false;
  const cachedResponse = await handleRequest(
    new Request('https://api.example.test/affiliate-catalog/read', {
      headers: { 'User-Agent': 'Brand-Tables-Manager/2.2.1' },
    }),
    env,
    {},
    fetchMock,
  );
  assert.equal(cachedResponse.status, 200);
  assert.deepEqual((await cachedResponse.json()).catalog, catalog);
  assert.equal(githubCalls, callsAfterWarmup);
});

test('affiliate catalog read fails safely when neither snapshot nor GitHub is available', async () => {
  const env = await environment();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(env, {
    AFFILIATE_GITHUB_APP_ID: String(Date.now() + 200),
    AFFILIATE_GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    AFFILIATE_GITHUB_OWNER: 'AleksandrDruk',
    AFFILIATE_GITHUB_REPO: 'btm-affiliate-library',
    AFFILIATE_GITHUB_BASE_BRANCH: 'main',
  });

  const response = await handleRequest(
    new Request('https://api.example.test/affiliate-catalog/read', {
      headers: { 'User-Agent': 'Brand-Tables-Manager/2.2.1' },
    }),
    env,
    {},
    async () => { throw new Error('simulated GitHub outage'); },
  );

  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'github_unavailable');
});

test('a concurrent publish wins over a slow read cache fill without serving the stale catalog', async () => {
  const env = await environment();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const nextSha = '9999999999999999999999999999999999999999';
  Object.assign(env, {
    AFFILIATE_GITHUB_APP_ID: String(Date.now() + 300),
    AFFILIATE_GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    AFFILIATE_GITHUB_OWNER: 'AleksandrDruk',
    AFFILIATE_GITHUB_REPO: 'btm-affiliate-library',
    AFFILIATE_GITHUB_BASE_BRANCH: 'main',
  });
  const oldCatalog = {
    schema_version: 2,
    catalog_version: 2,
    items: [{
      id: 'old', brand: 'Old', logo_id: '', version: 1, tags: [],
      links: [{ id: 'global', geo: 'GLOBAL', label: '', destination_url: 'https://tracking.example.test/old' }],
    }],
  };
  const newCatalog = {
    schema_version: 2,
    catalog_version: 3,
    items: [{
      id: 'new', brand: 'New', logo_id: '', version: 1, tags: [],
      links: [{ id: 'global', geo: 'GLOBAL', label: '', destination_url: 'https://tracking.example.test/new' }],
    }],
  };

  env.AFFILIATE_CATALOG_STATE.beforeNextCacheWrite(async () => {
    const stored = await publishApprovedAffiliateSnapshot(
      env.AFFILIATE_CATALOG_STATE,
      APPROVED_SHA,
      nextSha,
      serializeAffiliateCatalog(newCatalog),
    );
    assert.equal(stored.sha, nextSha);
  });

  const fetchMock = async (url, options = {}) => {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    if (pathname.endsWith('/installation')) return Response.json({ id: 303 });
    if (pathname === '/app/installations/303/access_tokens') {
      return Response.json({ token: 'race-read-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (pathname.endsWith(`/git/commits/${APPROVED_SHA}`)) return Response.json({ tree: { sha: 'old-tree' } });
    if (pathname.endsWith('/contents/catalog.json')) {
      assert.equal(parsed.searchParams.get('ref'), APPROVED_SHA);
      return Response.json({ content: Buffer.from(serializeAffiliateCatalog(oldCatalog)).toString('base64') });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };

  const response = await handleRequest(
    new Request('https://api.example.test/affiliate-catalog/read', {
      headers: { 'User-Agent': 'Brand-Tables-Manager/2.2.1' },
    }),
    env,
    {},
    fetchMock,
  );

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).catalog, newCatalog);
  assert.equal(env.AFFILIATE_CATALOG_STATE.current(), nextSha);
});
