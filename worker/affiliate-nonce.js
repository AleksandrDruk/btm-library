const NONCE_RETENTION_MS = 2 * 60 * 1000;

export class AffiliateNonceStore {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/consume') {
      return new Response(null, { status: 404 });
    }

    let accepted = false;
    await this.state.storage.transaction(async (transaction) => {
      const used = await transaction.get('used');
      if (used) return;
      await transaction.put('used', Date.now());
      accepted = true;
    });

    if (!accepted) {
      return new Response(null, { status: 409 });
    }

    await this.state.storage.setAlarm(Date.now() + NONCE_RETENTION_MS);
    return new Response(null, { status: 204 });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

export async function consumeAffiliateNonce(namespace, siteId, nonce) {
  if (
    !namespace
    || typeof namespace.idFromName !== 'function'
    || typeof namespace.get !== 'function'
  ) {
    throw new Error('Affiliate nonce store is not configured.');
  }

  const id = namespace.idFromName(`${siteId}:${nonce}`);
  const stub = namespace.get(id);
  const response = await stub.fetch('https://btm-affiliate-nonce.internal/consume', { method: 'POST' });
  if (response.status === 204) return true;
  if (response.status === 409) return false;
  throw new Error('Affiliate nonce store returned an unexpected response.');
}
