const APPROVED_SHA_KEY = 'approved_sha';
const APPROVED_SHA_PATH = '/approved-sha';
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function normalizeSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error('Affiliate approved SHA is invalid.');
  }
  return sha;
}

export class AffiliateCatalogState {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== APPROVED_SHA_PATH || url.search) {
      return new Response(null, { status: 404 });
    }

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
      const sha = normalizeSha(await request.text());
      await this.state.storage.put(APPROVED_SHA_KEY, sha);
      return new Response(null, { status: 204 });
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
      await setApprovedAffiliateCommit(namespace, fallback);
      return fallback;
    }
  }
  return stored;
}

export async function setApprovedAffiliateCommit(namespace, sha) {
  const normalized = normalizeSha(sha);
  const response = await catalogStateStub(namespace).fetch(
    'https://btm-affiliate-state.internal/approved-sha',
    { method: 'PUT', body: normalized },
  );
  if (response.status !== 204) {
    throw new Error('Affiliate catalog state rejected the approved commit.');
  }
  return normalized;
}
