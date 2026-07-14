import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateRepository } from '../scripts/validate-catalog.mjs';
import { createVisualFingerprint, VISUAL_SAMPLE_SIZE } from '../lib/visual-dedupe.js';

function png(marker = 0) {
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
  bytes[44] = marker;
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

function fingerprint(marker = 0) {
  const color = marker === 0 ? 40 : 220;
  const pixels = new Uint8ClampedArray(VISUAL_SAMPLE_SIZE * VISUAL_SAMPLE_SIZE * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = color;
    pixels[offset + 1] = color;
    pixels[offset + 2] = color;
    pixels[offset + 3] = 255;
  }
  return createVisualFingerprint(pixels, 2);
}

async function writeRepository(root, catalog, includeLogo) {
  await writeRepositoryFiles(root, catalog, includeLogo ? [[item.path, png()]] : []);
}

async function writeRepositoryFiles(root, catalog, files, fingerprintOverrides = new Map()) {
  await mkdir(path.join(root, 'logos'), { recursive: true });
  await writeFile(path.join(root, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(path.join(root, 'logos', '.gitkeep'), '');
  const visualItems = [];
  for (const [filePath, bytes] of files) {
    const absolute = path.join(root, filePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
    visualItems.push({
      path: filePath,
      sha256: digest(bytes),
      fingerprint: fingerprintOverrides.get(filePath) || fingerprint(bytes[44] || 0),
    });
  }
  await writeFile(path.join(root, 'visual-index.json'), `${JSON.stringify({
    schema_version: 1,
    catalog_version: catalog.catalog_version,
    items: visualItems,
  }, null, 2)}\n`);
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

test('validator supports a trusted one-time visual-index bootstrap', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'btm-validator-bootstrap-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const base = path.join(workspace, 'base');
  const legacyCandidate = path.join(workspace, 'legacy-candidate');
  const bootstrapCandidate = path.join(workspace, 'bootstrap-candidate');
  const catalog = { schema_version: 1, catalog_version: 2, items: [item] };
  await writeRepository(base, catalog, true);
  await writeRepository(legacyCandidate, catalog, true);
  await writeRepository(bootstrapCandidate, catalog, true);
  await rm(path.join(base, 'visual-index.json'));
  await rm(path.join(legacyCandidate, 'visual-index.json'));

  await assert.doesNotReject(() => validateRepository(legacyCandidate, base));
  await assert.doesNotReject(() => validateRepository(bootstrapCandidate, base));
});

test('validator rejects an unlisted file outside the versioned path contract', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'btm-validator-invalid-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeRepository(root, { schema_version: 1, catalog_version: 1, items: [] }, false);
  await mkdir(path.join(root, 'logos', 'brand'), { recursive: true });
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

test('validator rejects a new logo with bytes already present in immutable history', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'btm-validator-duplicate-new-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const base = path.join(workspace, 'base');
  const candidate = path.join(workspace, 'candidate');
  const duplicateItem = {
    ...item,
    id: 'other-primary',
    brand: 'Other',
    path: 'logos/other/other-primary-v1.png',
    suggested_filename: 'other.png',
  };

  await writeRepositoryFiles(base, { schema_version: 1, catalog_version: 2, items: [item] }, [
    [item.path, png()],
  ]);
  await writeRepositoryFiles(candidate, {
    schema_version: 1,
    catalog_version: 3,
    items: [item, duplicateItem],
  }, [
    [item.path, png()],
    [duplicateItem.path, png()],
  ]);

  await assert.rejects(() => validateRepository(candidate, base), /дублирует/);
});

test('validator rejects a version bump with unchanged image bytes', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'btm-validator-duplicate-update-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const base = path.join(workspace, 'base');
  const candidate = path.join(workspace, 'candidate');
  const updatedItem = {
    ...item,
    path: 'logos/brand/brand-primary-v2.png',
    version: 2,
  };

  await writeRepositoryFiles(base, { schema_version: 1, catalog_version: 2, items: [item] }, [
    [item.path, png()],
  ]);
  await writeRepositoryFiles(candidate, { schema_version: 1, catalog_version: 3, items: [updatedItem] }, [
    [item.path, png()],
    [updatedItem.path, png()],
  ]);

  await assert.rejects(() => validateRepository(candidate, base), /дублирует/);
});

test('validator accepts a version bump with different image bytes', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'btm-validator-distinct-update-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const base = path.join(workspace, 'base');
  const candidate = path.join(workspace, 'candidate');
  const updatedItem = {
    ...item,
    path: 'logos/brand/brand-primary-v2.png',
    version: 2,
  };

  await writeRepositoryFiles(base, { schema_version: 1, catalog_version: 2, items: [item] }, [
    [item.path, png()],
  ]);
  await writeRepositoryFiles(candidate, { schema_version: 1, catalog_version: 3, items: [updatedItem] }, [
    [item.path, png()],
    [updatedItem.path, png(1)],
  ]);

  await assert.doesNotReject(() => validateRepository(candidate, base));
});

test('validator rejects different bytes with the same visual fingerprint', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'btm-validator-visual-duplicate-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const base = path.join(workspace, 'base');
  const candidate = path.join(workspace, 'candidate');
  const duplicateItem = {
    ...item,
    id: 'other-primary',
    brand: 'Other',
    path: 'logos/other/other-primary-v1.png',
    suggested_filename: 'other.png',
  };
  const sharedFingerprint = fingerprint(0);

  await writeRepositoryFiles(base, { schema_version: 1, catalog_version: 2, items: [item] }, [
    [item.path, png()],
  ], new Map([[item.path, sharedFingerprint]]));
  await writeRepositoryFiles(candidate, {
    schema_version: 1,
    catalog_version: 3,
    items: [item, duplicateItem],
  }, [
    [item.path, png()],
    [duplicateItem.path, png(1)],
  ], new Map([
    [item.path, sharedFingerprint],
    [duplicateItem.path, sharedFingerprint],
  ]));
  await rm(path.join(base, 'visual-index.json'));

  await assert.rejects(() => validateRepository(candidate, base), /визуально дублирует/);
});
