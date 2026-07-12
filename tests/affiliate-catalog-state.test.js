import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AffiliateCatalogState,
  cacheApprovedAffiliateSnapshot,
  getApprovedAffiliateCommit,
  getApprovedAffiliateSnapshot,
  publishApprovedAffiliateSnapshot,
  setApprovedAffiliateCommit,
} from '../worker/affiliate-catalog-state.js';

const INITIAL_SHA = '1111111111111111111111111111111111111111';
const NEXT_SHA = '2222222222222222222222222222222222222222';
const THIRD_SHA = '3333333333333333333333333333333333333333';

function storageFixture() {
  const values = new Map();
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
    corrupt(key, value) {
      values.set(key, value);
    },
  };
  return storage;
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

test('approved catalog state performs only an exact configured maintenance migration', async () => {
  const state = new AffiliateCatalogState({ storage: storageFixture() });
  const namespace = stateNamespace(state);

  await setApprovedAffiliateCommit(namespace, INITIAL_SHA);
  assert.equal(
    await getApprovedAffiliateCommit(namespace, NEXT_SHA, INITIAL_SHA),
    NEXT_SHA,
  );
  assert.equal(await getApprovedAffiliateCommit(namespace, INITIAL_SHA), NEXT_SHA);
});

test('approved catalog state rejects malformed commit identifiers', async () => {
  const state = new AffiliateCatalogState({ storage: storageFixture() });
  const namespace = stateNamespace(state);

  await assert.rejects(() => setApprovedAffiliateCommit(namespace, 'main'));
  await assert.rejects(() => getApprovedAffiliateCommit(namespace, 'not-a-sha'));
});

test('approved catalog state stores and reads one integrity-checked snapshot atomically', async () => {
  const state = new AffiliateCatalogState({ storage: storageFixture() });
  const namespace = stateNamespace(state);
  const catalogText = '{"schema_version":2,"catalog_version":7,"items":[{"id":"one"}]}';

  const stored = await publishApprovedAffiliateSnapshot(namespace, INITIAL_SHA, NEXT_SHA, catalogText);
  assert.equal(stored.sha, NEXT_SHA);
  assert.equal(stored.catalog_version, 7);
  assert.equal(stored.item_count, 1);
  assert.match(stored.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(await getApprovedAffiliateSnapshot(namespace), stored);
  assert.equal(await getApprovedAffiliateCommit(namespace, INITIAL_SHA), NEXT_SHA);
});

test('a maintenance SHA write invalidates an older catalog snapshot', async () => {
  const state = new AffiliateCatalogState({ storage: storageFixture() });
  const namespace = stateNamespace(state);

  await publishApprovedAffiliateSnapshot(
    namespace,
    INITIAL_SHA,
    INITIAL_SHA,
    '{"schema_version":2,"catalog_version":2,"items":[]}',
  );
  await setApprovedAffiliateCommit(namespace, NEXT_SHA);

  assert.equal(await getApprovedAffiliateSnapshot(namespace), null);
  assert.equal(await getApprovedAffiliateCommit(namespace, INITIAL_SHA), NEXT_SHA);
});

test('approved catalog state rejects a corrupted stored snapshot body', async () => {
  const storage = storageFixture();
  const state = new AffiliateCatalogState({ storage });
  const namespace = stateNamespace(state);

  const stored = await publishApprovedAffiliateSnapshot(
    namespace,
    INITIAL_SHA,
    INITIAL_SHA,
    '{"schema_version":2,"catalog_version":2,"items":[]}',
  );
  storage.corrupt('approved_snapshot', { ...stored, catalog_text: '{"catalog_version":2,"items":[1]}' });

  await assert.rejects(
    () => getApprovedAffiliateSnapshot(namespace),
    /integrity check failed/i,
  );
  assert.equal(await getApprovedAffiliateCommit(namespace, NEXT_SHA), INITIAL_SHA);
});

test('a stale cache fill cannot roll the authoritative approved SHA backwards', async () => {
  const state = new AffiliateCatalogState({ storage: storageFixture() });
  const namespace = stateNamespace(state);

  await setApprovedAffiliateCommit(namespace, NEXT_SHA);
  const stored = await cacheApprovedAffiliateSnapshot(
    namespace,
    INITIAL_SHA,
    '{"schema_version":2,"catalog_version":2,"items":[]}',
  );

  assert.equal(stored, null);
  assert.equal(await getApprovedAffiliateCommit(namespace, INITIAL_SHA), NEXT_SHA);
  assert.equal(await getApprovedAffiliateSnapshot(namespace), null);
});

test('a valid snapshot with a different authoritative SHA is never served', async () => {
  const storage = storageFixture();
  const state = new AffiliateCatalogState({ storage });
  const namespace = stateNamespace(state);

  await publishApprovedAffiliateSnapshot(
    namespace,
    INITIAL_SHA,
    INITIAL_SHA,
    '{"schema_version":2,"catalog_version":2,"items":[]}',
  );
  storage.corrupt('approved_sha', NEXT_SHA);

  assert.equal(await getApprovedAffiliateCommit(namespace, INITIAL_SHA), NEXT_SHA);
  assert.equal(await getApprovedAffiliateSnapshot(namespace), null);
});

test('a stale publish CAS cannot overwrite a newer approved SHA and snapshot', async () => {
  const state = new AffiliateCatalogState({ storage: storageFixture() });
  const namespace = stateNamespace(state);
  const currentText = '{"schema_version":2,"catalog_version":3,"items":[{"id":"current"}]}';

  const current = await publishApprovedAffiliateSnapshot(namespace, INITIAL_SHA, NEXT_SHA, currentText);
  const stale = await publishApprovedAffiliateSnapshot(
    namespace,
    INITIAL_SHA,
    THIRD_SHA,
    '{"schema_version":2,"catalog_version":4,"items":[]}',
  );

  assert.equal(stale, null);
  assert.equal(await getApprovedAffiliateCommit(namespace, INITIAL_SHA), NEXT_SHA);
  assert.deepEqual(await getApprovedAffiliateSnapshot(namespace), current);
});

test('the first exact cache fill initializes a fresh Durable Object atomically', async () => {
  const state = new AffiliateCatalogState({ storage: storageFixture() });
  const namespace = stateNamespace(state);
  const catalogText = '{"schema_version":2,"catalog_version":2,"items":[{"id":"one"}]}';

  assert.equal(await getApprovedAffiliateCommit(namespace, INITIAL_SHA), INITIAL_SHA);
  const cached = await cacheApprovedAffiliateSnapshot(namespace, INITIAL_SHA, catalogText);

  assert.equal(cached.sha, INITIAL_SHA);
  assert.equal(await getApprovedAffiliateCommit(namespace, NEXT_SHA), INITIAL_SHA);
  assert.deepEqual(await getApprovedAffiliateSnapshot(namespace), cached);
});

test('conditional maintenance migration does not clobber a concurrent publish', async () => {
  const state = new AffiliateCatalogState({ storage: storageFixture() });
  const namespace = stateNamespace(state);

  await setApprovedAffiliateCommit(namespace, NEXT_SHA);
  assert.equal(await setApprovedAffiliateCommit(namespace, THIRD_SHA, INITIAL_SHA), null);
  assert.equal(await getApprovedAffiliateCommit(namespace, INITIAL_SHA), NEXT_SHA);
});
