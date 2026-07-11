import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AffiliateCatalogError,
  affiliateBrandKey,
  buildAffiliateCatalogUpdate,
  normalizeDestinationUrl,
  serializeAffiliateCatalogSnapshot,
  validateAffiliateCatalog,
  validateAffiliateCatalogSnapshot,
  validateAffiliateCatalogTransition,
} from '../lib/affiliate-catalog.js';

const emptyCatalog = () => ({ schema_version: 2, catalog_version: 1, items: [] });
const legacyEmptyCatalog = () => ({ schema_version: 1, catalog_version: 1, items: [] });

test('uses one normalized brand identity for validation and UI guidance', () => {
  assert.equal(affiliateBrandKey('Stone Vegas'), affiliateBrandKey('  STONE-VÉGAS  '));
  assert.equal(affiliateBrandKey('StoneVegas'), affiliateBrandKey('Stone Vegas'));
});

function link(geo, destinationUrl, options = {}) {
  return {
    id: options.id || '',
    geo,
    label: options.label || '',
    destination_url: destinationUrl,
  };
}

test('creates one brand with independent GEO links without rewriting tracking parameters', () => {
  const italian = 'https://tracking.example.test/click?b=2&a=%2Fvalue+kept#offer';
  const french = 'https://tracking.example.test/click?campaign=fr';
  const update = buildAffiliateCatalogUpdate(emptyCatalog(), [{
    mode: 'new',
    asset_id: '',
    brand: 'Vegas Hero',
    logo_id: 'vegas-hero-primary',
    links: [link('IT', italian), link('FR', french)],
    tags: 'vegas hero, casino',
  }]);

  assert.equal(update.catalog.catalog_version, 2);
  assert.deepEqual(update.catalog.items, [{
    id: 'vegas-hero',
    brand: 'Vegas Hero',
    logo_id: 'vegas-hero-primary',
    version: 1,
    tags: ['vegas hero', 'casino'],
    links: [
      { id: 'fr', geo: 'FR', label: '', destination_url: french },
      { id: 'it', geo: 'IT', label: '', destination_url: italian },
    ],
  }]);
  assert.equal(update.changes[0].links, 2);
});

test('allows the same destination in different GEOs for one brand', () => {
  const destination = 'https://tracking.example.test/shared?campaign=42';
  const catalog = buildAffiliateCatalogUpdate(emptyCatalog(), [{
    mode: 'new',
    asset_id: '',
    brand: 'Shared Brand',
    logo_id: '',
    links: [link('IT', destination), link('FR', destination)],
    tags: [],
  }]).catalog;
  assert.equal(catalog.items[0].links.length, 2);
});

test('rejects normalized duplicate brands and one destination assigned to different brands', () => {
  const destination = 'https://tracking.example.test/shared';
  const first = buildAffiliateCatalogUpdate(emptyCatalog(), [{
    mode: 'new',
    asset_id: '',
    brand: 'Stone Vegas',
    logo_id: '',
    links: [link('IT', destination)],
    tags: [],
  }]).catalog;

  assert.throws(() => buildAffiliateCatalogUpdate(first, [{
    mode: 'new',
    asset_id: '',
    brand: 'StoneVegas',
    logo_id: '',
    links: [link('FR', 'https://tracking.example.test/other')],
    tags: [],
  }]), (error) => error instanceof AffiliateCatalogError && error.code === 'duplicate_brand');

  assert.throws(() => buildAffiliateCatalogUpdate(first, [{
    mode: 'new',
    asset_id: '',
    brand: 'Another Brand',
    logo_id: '',
    links: [link('FR', destination)],
    tags: [],
  }]), (error) => error instanceof AffiliateCatalogError && error.code === 'duplicate_destination_brand');
});

test('keeps stable brand and link ids, increments version, and supports deletion', () => {
  const created = buildAffiliateCatalogUpdate(emptyCatalog(), [{
    mode: 'new',
    asset_id: '',
    brand: 'Vegas Hero',
    logo_id: '',
    links: [link('IT', 'https://tracking.example.test/first')],
    tags: [],
  }]);
  const updated = buildAffiliateCatalogUpdate(created.catalog, [{
    mode: 'update',
    asset_id: 'vegas-hero',
    brand: 'Vegas Hero Casino',
    logo_id: '',
    links: [
      link('IT', 'https://tracking.example.test/second?source=btm', { id: 'it' }),
      link('IT', 'https://tracking.example.test/backup', { label: 'Backup' }),
    ],
    tags: ['vegas hero'],
  }]);

  assert.equal(updated.catalog.items[0].id, 'vegas-hero');
  assert.equal(updated.catalog.items[0].version, 2);
  assert.deepEqual(updated.catalog.items[0].links.map((item) => item.id), ['it', 'it-backup']);

  const removed = buildAffiliateCatalogUpdate(updated.catalog, [{ mode: 'delete', asset_id: 'vegas-hero' }]);
  assert.equal(removed.catalog.items.length, 0);
  assert.equal(removed.changes[0].mode, 'delete');
});

test('rejects duplicate destinations in one GEO and unsafe destination URLs', () => {
  const destination = 'https://tracking.example.test/duplicate';
  assert.throws(() => buildAffiliateCatalogUpdate(emptyCatalog(), [{
    mode: 'new',
    asset_id: '',
    brand: 'Duplicate Brand',
    logo_id: '',
    links: [link('IT', destination), link('IT', destination, { label: 'Second' })],
    tags: [],
  }]), (error) => error instanceof AffiliateCatalogError && error.code === 'duplicate_geo_destination');

  assert.throws(
    () => normalizeDestinationUrl('https://user:secret@example.test/path'),
    (error) => error instanceof AffiliateCatalogError && error.code === 'invalid_destination_url',
  );
  assert.throws(
    () => normalizeDestinationUrl('https://example.test/a path'),
    (error) => error instanceof AffiliateCatalogError && error.code === 'invalid_destination_url',
  );
});

test('rejects a serialized catalog before the GitHub Contents API safe limit', () => {
  const longDestination = `https://tracking.example.test/click?q=${'a'.repeat(4050)}`;
  const items = Array.from({ length: 240 }, (_, index) => ({
    id: `brand-${index}`,
    brand: `Brand ${index}`,
    logo_id: '',
    version: 1,
    tags: [],
    links: [{ id: 'global', geo: 'GLOBAL', label: '', destination_url: `${longDestination}${index}` }],
  }));

  assert.throws(
    () => validateAffiliateCatalog({ schema_version: 2, catalog_version: 1, items }),
    (error) => error instanceof AffiliateCatalogError && error.code === 'catalog_too_large',
  );
});

test('normalizes only the empty legacy v1 snapshot during the schema v2 transition', () => {
  const legacy = legacyEmptyCatalog();
  const snapshot = validateAffiliateCatalogSnapshot(legacy);
  assert.equal(snapshot.source_schema_version, 1);
  assert.deepEqual(snapshot.catalog, emptyCatalog());
  assert.equal(serializeAffiliateCatalogSnapshot(legacy), `${JSON.stringify(legacy, null, 2)}\n`);

  const candidate = buildAffiliateCatalogUpdate(snapshot.catalog, [{
    mode: 'new',
    asset_id: '',
    brand: 'Vegas Hero',
    logo_id: '',
    links: [link('IT', 'https://tracking.example.test/vegas')],
    tags: [],
  }]).catalog;
  const transition = validateAffiliateCatalogTransition(legacy, candidate, { requireChange: true });
  assert.equal(transition.changed, true);
  assert.equal(transition.base_source_schema_version, 1);
  assert.equal(transition.candidate.catalog_version, 2);

  assert.throws(
    () => validateAffiliateCatalogTransition(legacy, { ...candidate, catalog_version: 3 }),
    (error) => error instanceof AffiliateCatalogError && error.code === 'catalog_version_transition',
  );
});
