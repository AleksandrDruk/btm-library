import test from 'node:test';
import assert from 'node:assert/strict';
import { AffiliateNonceStore, consumeAffiliateNonce } from '../worker/affiliate-nonce.js';

function storageFixture() {
  const values = new Map();
  return {
    values,
    alarmAt: 0,
    async transaction(callback) {
      await callback({
        get: async (key) => values.get(key),
        put: async (key, value) => values.set(key, value),
      });
    },
    async setAlarm(timestamp) {
      this.alarmAt = timestamp;
    },
    async deleteAll() {
      values.clear();
    },
  };
}

test('Durable Object consumes an affiliate nonce only once until cleanup', async () => {
  const storage = storageFixture();
  const nonceStore = new AffiliateNonceStore({ storage });
  const request = new Request('https://internal.test/consume', { method: 'POST' });

  assert.equal((await nonceStore.fetch(request)).status, 204);
  assert.equal((await nonceStore.fetch(request)).status, 409);
  assert.ok(storage.alarmAt > Date.now());

  await nonceStore.alarm();
  assert.equal((await nonceStore.fetch(request)).status, 204);
});

test('nonce namespace helper maps Durable Object responses to booleans', async () => {
  const responses = [204, 409];
  const namespace = {
    idFromName: (name) => `id:${name}`,
    get: (id) => ({
      fetch: async () => {
        assert.equal(id, 'id:site-1:nonce-1');
        return new Response(null, { status: responses.shift() });
      },
    }),
  };

  assert.equal(await consumeAffiliateNonce(namespace, 'site-1', 'nonce-1'), true);
  assert.equal(await consumeAffiliateNonce(namespace, 'site-1', 'nonce-1'), false);
});
