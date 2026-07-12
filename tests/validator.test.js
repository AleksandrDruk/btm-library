import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateRepository } from '../scripts/validate-catalog.mjs';

function png() {
  const bytes = new Uint8Array(57);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 120, false);
  view.setUint32(20, 60, false);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([0, 0, 0, 0], 29);
  bytes.set([0, 0, 0, 0], 33);
  bytes.set([73, 68, 65, 84], 37);
  bytes.set([0, 0, 0, 0], 41);
  bytes.set([0, 0, 0, 0], 45);
  bytes.set([73, 69, 78, 68], 49);
  bytes.set([0, 0, 0, 0], 53);
  return bytes;
}

const item = {
  id: 'brand-primary',
  brand: 'Brand',
  variant: 'Primary',
  path: 'logos/brand/brand-primary-v1.png',
  suggested_filename: 'brand.png',
  version: 1,
  tags: ['brand', 'primary'],
};

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeRepository(root, catalog, includeLogo) {
  await mkdir(path.join(root, 'logos', 'brand'), { recursive: true });
  await writeFile(path.join(root, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(path.join(root, 'logos', '.gitkeep'), '');
  if (includeLogo) {
    await writeFile(path.join(root, item.path), png());
  }
}

test('validator accepts catalog deletion with retained or purged current file', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'btm-validator-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const base = path.join(workspace, 'base');
  const retained = path.join(workspace, 'retained');
  const purged = path.join(workspace, 'purged');
  await writeRepository(base, { schema_version: 1, catalog_version: 2, items: [item] }, true);
  await writeRepository(retained, { schema_version: 1, catalog_version: 3, items: [] }, true);
  await writeRepository(purged, { schema_version: 1, catalog_version: 3, items: [] }, false);

  await assert.doesNotReject(() => validateRepository(retained, base));
  await assert.doesNotReject(() => validateRepository(purged, base));
});

test('validator rejects an unlisted file outside the versioned path contract', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'btm-validator-invalid-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeRepository(root, { schema_version: 1, catalog_version: 1, items: [] }, false);
  await writeFile(path.join(root, 'logos', 'brand', 'unversioned.png'), png());

  await assert.rejects(() => validateRepository(root), /versioned path/);
});

test('validator accepts the exact schema 1 to 2 digest-only migration', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'btm-validator-schema-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const base = path.join(workspace, 'base');
  const candidate = path.join(workspace, 'candidate');
  await writeRepository(base, { schema_version: 1, catalog_version: 2, items: [item] }, true);
  await writeRepository(candidate, {
    schema_version: 2,
    catalog_version: 3,
    items: [{ ...item, sha256: digest(png()) }],
  }, true);

  await assert.doesNotReject(() => validateRepository(candidate, base));
});

test('validator rejects a schema 2 digest that does not match image bytes', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'btm-validator-digest-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeRepository(root, {
    schema_version: 2,
    catalog_version: 3,
    items: [{ ...item, sha256: '0'.repeat(64) }],
  }, true);

  await assert.rejects(() => validateRepository(root), /SHA-256/);
});
