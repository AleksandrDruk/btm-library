import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AffiliateCatalogError,
  buildAffiliateCatalogUpdate,
  normalizeDestinationUrl,
  validateAffiliateCatalog,
} from '../lib/affiliate-catalog.js';

const emptyCatalog = () => ({ schema_version: 1, catalog_version: 1, items: [] });

test('creates one global affiliate URL per brand without rewriting tracking parameters', () => {
  const destination = 'https://tracking.example.test/click?b=2&a=%2Fvalue+kept#offer';
  const update = buildAffiliateCatalogUpdate(emptyCatalog(), [{
    mode: 'new',
    brand: 'Vegas Hero',
    destination_url: destination,
    tags: 'vegas hero, casino',
  }]);

  assert.equal(update.catalog.catalog_version, 2);
  assert.deepEqual(update.catalog.items, [{
    id: 'vegas-hero',
    brand: 'Vegas Hero',
    destination_url: destination,
    version: 1,
    tags: ['vegas hero', 'casino'],
  }]);
  assert.equal(update.changes[0].mode, 'new');
});

test('rejects a second case-insensitive brand entry', () => {
  const catalog = {
    schema_version: 1,
    catalog_version: 2,
    items: [{
      id: 'vegas-hero',
      brand: 'Vegas Hero',
      destination_url: 'https://tracking.example.test/vegas',
      version: 1,
      tags: [],
    }],
  };

  assert.throws(() => validateAffiliateCatalog({
    ...catalog,
    items: [...catalog.items, {
      id: 'vegas-hero-copy',
      brand: 'vegas hero',
      destination_url: 'https://tracking.example.test/duplicate',
      version: 1,
      tags: [],
    }],
  }), (error) => error instanceof AffiliateCatalogError && error.code === 'duplicate_brand');
});

test('keeps a stable id, increments version on update and supports catalog deletion', () => {
  const created = buildAffiliateCatalogUpdate(emptyCatalog(), [{
    mode: 'new',
    brand: 'Vegas Hero',
    destination_url: 'https://tracking.example.test/first',
    tags: [],
  }]);
  const updated = buildAffiliateCatalogUpdate(created.catalog, [{
    mode: 'update',
    asset_id: 'vegas-hero',
    brand: 'Vegas Hero Casino',
    destination_url: 'https://tracking.example.test/second?source=btm',
    tags: ['vegas hero'],
  }]);

  assert.equal(updated.catalog.items[0].id, 'vegas-hero');
  assert.equal(updated.catalog.items[0].version, 2);
  assert.equal(updated.catalog.items[0].brand, 'Vegas Hero Casino');

  const removed = buildAffiliateCatalogUpdate(updated.catalog, [{
    mode: 'delete',
    asset_id: 'vegas-hero',
  }]);
  assert.equal(removed.catalog.items.length, 0);
  assert.equal(removed.changes[0].mode, 'delete');
});

test('rejects credentials and unencoded spaces in destination URLs', () => {
  assert.throws(
    () => normalizeDestinationUrl('https://user:secret@example.test/path'),
    (error) => error instanceof AffiliateCatalogError && error.code === 'invalid_destination_url',
  );
  assert.throws(
    () => normalizeDestinationUrl('https://example.test/a path'),
    (error) => error instanceof AffiliateCatalogError && error.code === 'invalid_destination_url',
  );
});

test('rejects a serialized catalog before it crosses the GitHub Contents API safe limit', () => {
  const longDestination = `https://tracking.example.test/click?q=${'a'.repeat(4050)}`;
  const items = Array.from({ length: 240 }, (_, index) => ({
    id: `brand-${index}`,
    brand: `Brand ${index}`,
    destination_url: longDestination,
    version: 1,
    tags: [],
  }));

  assert.throws(
    () => validateAffiliateCatalog({ schema_version: 1, catalog_version: 1, items }),
    (error) => error instanceof AffiliateCatalogError && error.code === 'catalog_too_large',
  );
});
