import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AffiliateCatalogState,
  getApprovedAffiliateCommit,
  setApprovedAffiliateCommit,
} from '../worker/affiliate-catalog-state.js';

const INITIAL_SHA = '1111111111111111111111111111111111111111';
const NEXT_SHA = '2222222222222222222222222222222222222222';

function storageFixture() {
  const values = new Map();
  return {
    async get(key) {
      return values.get(key);
    },
    async put(key, value) {
      values.set(key, value);
    },
  };
}

function stateNamespace(state) {
  return {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: async (url, options) => {
        assert.equal(id, 'approved-affiliate-catalog');
        return state.fetch(new Request(url, options));
      },
    }),
  };
}

test('approved catalog state fails closed to the configured bootstrap SHA', async () => {
  const state = new AffiliateCatalogState({ storage: storageFixture() });
  const namespace = stateNamespace(state);

  assert.equal(await getApprovedAffiliateCommit(namespace, INITIAL_SHA), INITIAL_SHA);
  assert.equal(await setApprovedAffiliateCommit(namespace, NEXT_SHA), NEXT_SHA);
  assert.equal(await getApprovedAffiliateCommit(namespace, INITIAL_SHA), NEXT_SHA);
});

test('approved catalog state rejects malformed commit identifiers', async () => {
  const state = new AffiliateCatalogState({ storage: storageFixture() });
  const namespace = stateNamespace(state);

  await assert.rejects(() => setApprovedAffiliateCommit(namespace, 'main'));
  await assert.rejects(() => getApprovedAffiliateCommit(namespace, 'not-a-sha'));
});
