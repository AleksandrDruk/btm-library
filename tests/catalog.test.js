import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogUpdate, CatalogError, validateCatalog } from '../lib/catalog.js';

const emptyCatalog = () => ({ schema_version: 1, catalog_version: 1, items: [] });
const image = (extension = 'png', sha256 = '') => ({
  extension,
  width: 200,
  height: 100,
  bytes: 1000,
  ...(sha256 ? { sha256 } : {}),
});
const digest = 'a'.repeat(64);

test('same brand supports distinct variants without duplicate ids', () => {
  const result = buildCatalogUpdate(emptyCatalog(), [
    { mode: 'new', brand: 'Bet Republic', variant: 'Primary', suggested_filename: 'bet-republic', tags: 'bet, primary', image: image() },
    { mode: 'new', brand: 'Bet Republic', variant: 'Dark', suggested_filename: 'bet-republic-dark', tags: 'bet, dark', image: image('webp') },
  ]);

  assert.equal(result.catalog.catalog_version, 2);
  assert.deepEqual(result.catalog.items.map((item) => item.id), ['bet-republic-primary', 'bet-republic-dark']);
  assert.equal(result.catalog.items[1].path, 'logos/bet-republic/bet-republic-dark-v1.webp');
});
test('same brand and variant is rejected as a duplicate', () => {
  assert.throws(
    () => buildCatalogUpdate(emptyCatalog(), [
      { mode: 'new', brand: 'Ivibet', variant: 'Primary', image: image() },
      { mode: 'new', brand: 'ivibet', variant: 'primary', image: image() },
    ]),
    (error) => error instanceof CatalogError && ['duplicate_id', 'duplicate_brand_variant'].includes(error.code),
  );
});

test('update preserves id and increments version', () => {
  const first = buildCatalogUpdate(emptyCatalog(), [
    { mode: 'new', brand: 'Ivibet', variant: 'Primary', image: image() },
  ]).catalog;
  const second = buildCatalogUpdate(first, [
    { mode: 'update', asset_id: 'ivibet-primary', brand: 'Ivibet', variant: 'Dark', image: image('webp') },
  ]);

  assert.equal(second.catalog.catalog_version, 3);
  assert.equal(second.catalog.items[0].id, 'ivibet-primary');
  assert.equal(second.catalog.items[0].version, 2);
  assert.equal(second.catalog.items[0].path, 'logos/ivibet/ivibet-primary-v2.webp');
});

test('delete removes catalog item and carries purge choice', () => {
  const first = buildCatalogUpdate(emptyCatalog(), [
    { mode: 'new', brand: 'Slotuna', variant: 'Primary', image: image('webp') },
  ]).catalog;
  const deletion = buildCatalogUpdate(first, [
    { mode: 'delete', asset_id: 'slotuna-primary', purge_file: true },
  ]);

  assert.equal(deletion.catalog.items.length, 0);
  assert.equal(deletion.catalog.catalog_version, 3);
  assert.equal(deletion.changes[0].purge_file, true);
  assert.equal(deletion.changes[0].path, 'logos/slotuna/slotuna-primary-v1.webp');
});

test('manual duplicate brand and variant is rejected even with different ids', () => {
  assert.throws(() => validateCatalog({
    schema_version: 1,
    catalog_version: 2,
    items: [
      {
        id: 'brand-primary', brand: 'Brand', variant: 'Primary', path: 'logos/brand/brand-primary-v1.png',
        suggested_filename: 'brand-primary.png', version: 1, tags: [],
      },
      {
        id: 'brand-other', brand: 'brand', variant: 'primary', path: 'logos/brand/brand-other-v1.png',
        suggested_filename: 'brand-other.png', version: 1, tags: [],
      },
    ],
  }), (error) => error.code === 'duplicate_brand_variant');
});

test('schema 2 requires a lowercase SHA-256 digest for every item', () => {
  assert.throws(() => validateCatalog({
    schema_version: 2,
    catalog_version: 2,
    items: [{
      id: 'brand-primary',
      brand: 'Brand',
      variant: 'Primary',
      path: 'logos/brand/brand-primary-v1.png',
      suggested_filename: 'brand.png',
      version: 1,
      tags: [],
    }],
  }), (error) => error.code === 'invalid_keys');
});

test('schema 2 updates bind the catalog item to the uploaded image digest', () => {
  const result = buildCatalogUpdate(
    { schema_version: 2, catalog_version: 1, items: [] },
    [{
      mode: 'new',
      brand: 'Brand',
      variant: 'Primary',
      image: { ...image(), sha256: digest },
    }],
  );

  assert.equal(result.catalog.schema_version, 2);
  assert.equal(result.catalog.items[0].sha256, digest);
  assert.throws(
    () => buildCatalogUpdate(
      { schema_version: 2, catalog_version: 1, items: [] },
      [{ mode: 'new', brand: 'Other', variant: 'Primary', image: image() }],
    ),
    (error) => error.code === 'invalid_sha256',
  );
});

test('batch rejects the same image bytes under different names', () => {
  assert.throws(
    () => buildCatalogUpdate(emptyCatalog(), [
      { mode: 'new', brand: 'First', variant: 'Primary', image: image('png', digest) },
      { mode: 'new', brand: 'Second', variant: 'Primary', image: image('png', digest) },
    ]),
    (error) => error.code === 'duplicate_image_content',
  );
});

test('schema 2 rejects duplicate image digests in active catalog', () => {
  const first = {
    id: 'first-primary',
    brand: 'First',
    variant: 'Primary',
    path: 'logos/first/first-primary-v1.png',
    suggested_filename: 'first.png',
    version: 1,
    tags: [],
    sha256: digest,
  };
  const second = {
    ...first,
    id: 'second-primary',
    brand: 'Second',
    path: 'logos/second/second-primary-v1.png',
    suggested_filename: 'second.png',
  };

  assert.throws(
    () => validateCatalog({ schema_version: 2, catalog_version: 2, items: [first, second] }),
    (error) => error.code === 'duplicate_image_content',
  );
});
