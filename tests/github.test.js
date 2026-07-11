import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  createAffiliateCatalogPullRequest,
  createUploadPullRequest,
  getRepositorySnapshot,
} from '../worker/github.js';

test('GitHub App snapshot flow accepts the downloaded PKCS1 key and least-privilege token scope', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = {
    GITHUB_APP_ID: String(Date.now()),
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    GITHUB_OWNER: 'AleksandrDruk',
    GITHUB_REPO: 'btm-library',
    GITHUB_BASE_BRANCH: 'main',
  };
  const catalog = { schema_version: 1, catalog_version: 1, items: [] };
  let tokenRequestChecked = false;

  const fetchMock = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/installation')) {
      assert.match(options.headers.Authorization, /^Bearer /);
      return Response.json({ id: 42 });
    }
    if (pathname === '/app/installations/42/access_tokens') {
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(options.body), {
        repositories: ['btm-library'],
        permissions: { contents: 'write', pull_requests: 'write' },
      });
      tokenRequestChecked = true;
      return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (pathname.endsWith('/git/ref/heads/main')) {
      return Response.json({ object: { sha: 'base-commit' } });
    }
    if (pathname.endsWith('/git/commits/base-commit')) {
      return Response.json({ tree: { sha: 'base-tree' } });
    }
    if (pathname.endsWith('/contents/catalog.json')) {
      assert.equal(new URL(url).searchParams.get('ref'), 'base-commit');
      return Response.json({ content: Buffer.from(JSON.stringify(catalog)).toString('base64') });
    }
    throw new Error(`Unexpected GitHub request: ${pathname}`);
  };

  const snapshot = await getRepositorySnapshot(env, fetchMock);
  assert.equal(tokenRequestChecked, true);
  assert.equal(snapshot.baseCommitSha, 'base-commit');
  assert.equal(snapshot.baseTreeSha, 'base-tree');
  assert.deepEqual(snapshot.catalog, catalog);
});

test('GitHub tree removes only files explicitly marked for purge', async () => {
  const snapshot = {
    coordinates: { owner: 'AleksandrDruk', repo: 'btm-library', branch: 'main' },
    token: 'installation-token',
    baseCommitSha: 'base-commit',
    baseTreeSha: 'base-tree',
  };
  let treeBody = null;

  const fetchMock = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/git/blobs')) return Response.json({ sha: 'catalog-blob' });
    if (pathname.endsWith('/git/trees')) {
      treeBody = JSON.parse(options.body);
      return Response.json({ sha: 'new-tree' });
    }
    if (pathname.endsWith('/git/commits')) return Response.json({ sha: 'new-commit' });
    if (pathname.endsWith('/git/refs')) return Response.json({ ref: 'created' }, { status: 201 });
    if (pathname.endsWith('/pulls')) {
      return Response.json({ number: 7, html_url: 'https://github.com/AleksandrDruk/btm-library/pull/7' }, { status: 201 });
    }
    throw new Error(`Unexpected GitHub request: ${pathname}`);
  };

  const result = await createUploadPullRequest(snapshot, '{}\n', [
    { mode: 'delete', id: 'keep-primary', path: 'logos/keep/keep-primary-v1.png', purge_file: false, brand: 'Keep' },
    { mode: 'delete', id: 'purge-primary', path: 'logos/purge/purge-primary-v1.png', purge_file: true, brand: 'Purge' },
  ], new Map(), fetchMock);

  assert.equal(result.number, 7);
  assert.deepEqual(treeBody.tree, [
    { path: 'logos/purge/purge-primary-v1.png', mode: '100644', type: 'blob', sha: null },
    { path: 'catalog.json', mode: '100644', type: 'blob', sha: 'catalog-blob' },
  ]);
});

test('private affiliate snapshot requests a read-only installation token', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = {
    AFFILIATE_GITHUB_APP_ID: String(Date.now() + 1),
    AFFILIATE_GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    AFFILIATE_GITHUB_OWNER: 'AleksandrDruk',
    AFFILIATE_GITHUB_REPO: 'btm-affiliate-library',
    AFFILIATE_GITHUB_BASE_BRANCH: 'main',
  };
  const catalog = { schema_version: 2, catalog_version: 1, items: [] };

  const fetchMock = async (url, options = {}) => {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    if (pathname.endsWith('/installation')) return Response.json({ id: 84 });
    if (pathname === '/app/installations/84/access_tokens') {
      assert.deepEqual(JSON.parse(options.body), {
        repositories: ['btm-affiliate-library'],
        permissions: { contents: 'read' },
      });
      return Response.json({ token: 'affiliate-read-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'affiliate-base' } });
    if (pathname.endsWith('/git/commits/affiliate-base')) return Response.json({ tree: { sha: 'affiliate-tree' } });
    if (pathname.endsWith('/contents/catalog.json')) {
      assert.equal(parsed.searchParams.get('ref'), 'affiliate-base');
      return Response.json({ content: Buffer.from(JSON.stringify(catalog)).toString('base64') });
    }
    throw new Error(`Unexpected GitHub request: ${pathname}`);
  };

  const snapshot = await getRepositorySnapshot(env, fetchMock, {
    prefix: 'AFFILIATE_GITHUB',
    access: 'read',
  });
  assert.equal(snapshot.coordinates.repo, 'btm-affiliate-library');
  assert.deepEqual(snapshot.catalog, catalog);
});

test('affiliate catalog proposal changes only catalog.json in a separate PR branch', async () => {
  const snapshot = {
    coordinates: { owner: 'AleksandrDruk', repo: 'btm-affiliate-library', branch: 'main' },
    token: 'installation-token',
    baseCommitSha: 'base-commit',
    baseTreeSha: 'base-tree',
    catalogPath: 'catalog.json',
  };
  let treeBody = null;
  let pullBody = null;

  const fetchMock = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/git/blobs')) return Response.json({ sha: 'affiliate-catalog-blob' });
    if (pathname.endsWith('/git/trees')) {
      treeBody = JSON.parse(options.body);
      return Response.json({ sha: 'new-tree' });
    }
    if (pathname.endsWith('/git/commits')) return Response.json({ sha: 'new-commit' });
    if (pathname.endsWith('/git/refs')) return Response.json({ ref: 'created' }, { status: 201 });
    if (pathname.endsWith('/pulls')) {
      pullBody = JSON.parse(options.body);
      return Response.json({
        number: 9,
        html_url: 'https://github.com/AleksandrDruk/btm-affiliate-library/pull/9',
      }, { status: 201 });
    }
    throw new Error(`Unexpected GitHub request: ${pathname}`);
  };

  const result = await createAffiliateCatalogPullRequest(snapshot, '{}\n', [{
    mode: 'new',
    id: 'vegas-hero',
    brand: 'Vegas Hero',
    version: 1,
  }], fetchMock);

  assert.equal(result.number, 9);
  assert.deepEqual(treeBody.tree, [{
    path: 'catalog.json',
    mode: '100644',
    type: 'blob',
    sha: 'affiliate-catalog-blob',
  }]);
  assert.match(pullBody.head, /^affiliate-links\//);
  assert.equal(pullBody.base, 'main');
});
