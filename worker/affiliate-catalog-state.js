const APPROVED_SHA_KEY = 'approved_sha';
const APPROVED_SNAPSHOT_KEY = 'approved_snapshot';
const APPROVED_SHA_PATH = '/approved-sha';
const APPROVED_SNAPSHOT_PATH = '/approved-snapshot';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CATALOG_BYTES = 900 * 1024;
const encoder = new TextEncoder();

function normalizeSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error('Affiliate approved SHA is invalid.');
  }
  return sha;
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function createSnapshot(shaValue, catalogTextValue) {
  const sha = normalizeSha(shaValue);
  if (typeof catalogTextValue !== 'string' || encoder.encode(catalogTextValue).byteLength > MAX_CATALOG_BYTES) {
    throw new Error('Affiliate catalog snapshot is invalid.');
  }

  let catalog;
  try {
    catalog = JSON.parse(catalogTextValue);
  } catch {
    throw new Error('Affiliate catalog snapshot is invalid.');
  }
  if (
    catalog === null
    || typeof catalog !== 'object'
    || Array.isArray(catalog)
    || !Number.isInteger(catalog.catalog_version)
    || catalog.catalog_version < 1
    || !Array.isArray(catalog.items)
  ) {
    throw new Error('Affiliate catalog snapshot is invalid.');
  }

  return {
    sha,
    catalog_text: catalogTextValue,
    digest: await sha256Hex(catalogTextValue),
    catalog_version: catalog.catalog_version,
    item_count: catalog.items.length,
  };
}

async function normalizeStoredSnapshot(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Affiliate catalog snapshot is invalid.');
  }
  const snapshot = await createSnapshot(value.sha, value.catalog_text);
  if (
    typeof value.digest !== 'string'
    || !DIGEST_PATTERN.test(value.digest)
    || !hashEquals(snapshot.digest, value.digest)
    || value.catalog_version !== snapshot.catalog_version
    || value.item_count !== snapshot.item_count
  ) {
    throw new Error('Affiliate catalog snapshot integrity check failed.');
  }
  return snapshot;
}

function hashEquals(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function withStorageTransaction(storage, callback) {
  if (typeof storage.transaction === 'function') {
    return storage.transaction(callback);
  }
  return callback(storage);
}

export class AffiliateCatalogState {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (![APPROVED_SHA_PATH, APPROVED_SNAPSHOT_PATH].includes(url.pathname) || url.search) {
      return new Response(null, { status: 404 });
    }

    if (url.pathname === APPROVED_SHA_PATH) {
      if (request.method === 'GET') {
        const sha = await this.state.storage.get(APPROVED_SHA_KEY);
        if (typeof sha !== 'string') {
          return new Response(null, { status: 404 });
        }
        return new Response(normalizeSha(sha), {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }

      if (request.method === 'PUT') {
        const bodyText = await request.text();
        let sha;
        let expectedSha = '';
        if (bodyText.trim().startsWith('{')) {
          let body;
          try {
            body = JSON.parse(bodyText);
          } catch {
            throw new Error('Affiliate approved SHA operation is invalid.');
          }
          sha = normalizeSha(body?.sha);
          expectedSha = normalizeSha(body?.expected_sha);
        } else {
          sha = normalizeSha(bodyText);
        }
        const stored = await withStorageTransaction(this.state.storage, async (transaction) => {
          if (expectedSha) {
            const currentValue = await transaction.get(APPROVED_SHA_KEY);
            if (typeof currentValue !== 'string' || normalizeSha(currentValue) !== expectedSha) {
              return false;
            }
          }
          await transaction.put(APPROVED_SHA_KEY, sha);
          if (typeof transaction.delete === 'function') {
            await transaction.delete(APPROVED_SNAPSHOT_KEY);
          }
          return true;
        });
        if (!stored) {
          return new Response(null, { status: 409 });
        }
        return new Response(null, { status: 204 });
      }

      return new Response(null, { status: 405, headers: { Allow: 'GET, PUT' } });
    }

    if (request.method === 'GET') {
      const [value, approvedShaValue] = await Promise.all([
        this.state.storage.get(APPROVED_SNAPSHOT_KEY),
        this.state.storage.get(APPROVED_SHA_KEY),
      ]);
      if (value === undefined) {
        return new Response(null, { status: 404 });
      }
      const snapshot = await normalizeStoredSnapshot(value);
      if (typeof approvedShaValue !== 'string' || snapshot.sha !== normalizeSha(approvedShaValue)) {
        return new Response(null, { status: 409 });
      }
      return Response.json(snapshot, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (request.method === 'PUT') {
      const bodyText = await request.text();
      if (encoder.encode(bodyText).byteLength > (MAX_CATALOG_BYTES * 2) + 4096) {
        throw new Error('Affiliate catalog snapshot is too large.');
      }
      let body;
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw new Error('Affiliate catalog snapshot is invalid.');
      }
      const mode = body?.mode === 'cache' || body?.mode === 'publish' ? body.mode : '';
      if (!mode) {
        throw new Error('Affiliate catalog snapshot operation is invalid.');
      }
      const snapshot = await createSnapshot(body?.sha, body?.catalog_text);
      const expectedSha = mode === 'publish' ? normalizeSha(body?.expected_sha) : snapshot.sha;
      const stored = await withStorageTransaction(this.state.storage, async (transaction) => {
        const currentValue = await transaction.get(APPROVED_SHA_KEY);
        const currentSha = typeof currentValue === 'string' ? normalizeSha(currentValue) : '';
        if (currentSha && currentSha !== expectedSha) {
          return false;
        }
        if (mode === 'publish') {
          await transaction.put(APPROVED_SHA_KEY, snapshot.sha);
        } else if (!currentSha) {
          // Establish the configured bootstrap SHA on the first successful
          // exact-SHA cache fill without permitting a later overwrite.
          await transaction.put(APPROVED_SHA_KEY, snapshot.sha);
        }
        await transaction.put(APPROVED_SNAPSHOT_KEY, snapshot);
        return true;
      });
      if (!stored) {
        return new Response(null, { status: 409 });
      }
      return Response.json(snapshot, { status: 200, headers: { 'Cache-Control': 'no-store' } });
    }

    return new Response(null, { status: 405, headers: { Allow: 'GET, PUT' } });
  }
}

function catalogStateStub(namespace) {
  if (
    !namespace
    || typeof namespace.idFromName !== 'function'
    || typeof namespace.get !== 'function'
  ) {
    throw new Error('Affiliate catalog state is not configured.');
  }
  return namespace.get(namespace.idFromName('approved-affiliate-catalog'));
}

export async function getApprovedAffiliateCommit(namespace, initialSha, previousSha = '') {
  const fallback = normalizeSha(initialSha);
  const response = await catalogStateStub(namespace).fetch(
    'https://btm-affiliate-state.internal/approved-sha',
  );
  if (response.status === 404) return fallback;
  if (response.status !== 200) {
    throw new Error('Affiliate catalog state returned an unexpected response.');
  }
  const stored = normalizeSha(await response.text());
  if (previousSha) {
    const previous = normalizeSha(previousSha);
    if (stored === previous && fallback !== previous) {
      const migrated = await setApprovedAffiliateCommit(namespace, fallback, previous);
      if (migrated) return fallback;

      const latestResponse = await catalogStateStub(namespace).fetch(
        'https://btm-affiliate-state.internal/approved-sha',
      );
      if (latestResponse.status !== 200) {
        throw new Error('Affiliate catalog state returned an unexpected response.');
      }
      return normalizeSha(await latestResponse.text());
    }
  }
  return stored;
}

export async function setApprovedAffiliateCommit(namespace, sha, expectedSha = '') {
  const normalized = normalizeSha(sha);
  const expected = expectedSha ? normalizeSha(expectedSha) : '';
  const response = await catalogStateStub(namespace).fetch(
    'https://btm-affiliate-state.internal/approved-sha',
    {
      method: 'PUT',
      body: expected
        ? JSON.stringify({ sha: normalized, expected_sha: expected })
        : normalized,
    },
  );
  if (response.status === 409) return null;
  if (response.status !== 204) {
    throw new Error('Affiliate catalog state rejected the approved commit.');
  }
  return normalized;
}

export async function getApprovedAffiliateSnapshot(namespace) {
  const response = await catalogStateStub(namespace).fetch(
    'https://btm-affiliate-state.internal/approved-snapshot',
  );
  if (response.status === 404) return null;
  if (response.status === 409) return null;
  if (response.status !== 200) {
    throw new Error('Affiliate catalog state returned an unexpected snapshot response.');
  }
  return normalizeStoredSnapshot(await response.json());
}

async function writeApprovedAffiliateSnapshot(namespace, mode, expectedSha, sha, catalogText) {
  const normalizedSha = normalizeSha(sha);
  const normalizedExpectedSha = normalizeSha(expectedSha);
  const response = await catalogStateStub(namespace).fetch(
    'https://btm-affiliate-state.internal/approved-snapshot',
    {
      method: 'PUT',
      body: JSON.stringify({
        mode,
        expected_sha: normalizedExpectedSha,
        sha: normalizedSha,
        catalog_text: catalogText,
      }),
      headers: { 'Content-Type': 'application/json' },
    },
  );
  if (response.status === 409) return null;
  if (response.status !== 200) {
    throw new Error('Affiliate catalog state rejected the approved snapshot.');
  }
  return normalizeStoredSnapshot(await response.json());
}

export async function cacheApprovedAffiliateSnapshot(namespace, sha, catalogText) {
  return writeApprovedAffiliateSnapshot(namespace, 'cache', sha, sha, catalogText);
}

export async function publishApprovedAffiliateSnapshot(namespace, expectedSha, sha, catalogText) {
  return writeApprovedAffiliateSnapshot(namespace, 'publish', expectedSha, sha, catalogText);
}
