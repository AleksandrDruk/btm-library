import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVisualFingerprint,
  VISUAL_SAMPLE_SIZE,
} from '../lib/visual-dedupe.js';
import {
  buildVisualIndexUpdate,
  validateVisualIndex,
  VisualIndexError,
} from '../lib/visual-index.js';

function fingerprint(red = 30, green = 80, blue = 160, aspectRatio = 2) {
  const pixels = new Uint8ClampedArray(VISUAL_SAMPLE_SIZE * VISUAL_SAMPLE_SIZE * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = 255;
  }
  return createVisualFingerprint(pixels, aspectRatio);
}

const emptyIndex = () => ({ schema_version: 1, catalog_version: 1, items: [] });

test('visual index stores a fingerprint tied to exact bytes and dimensions', () => {
  const result = buildVisualIndexUpdate(emptyIndex(), 2, [{
    mode: 'new',
    path: 'logos/brand/brand-primary-v1.png',
    sha256: 'a'.repeat(64),
    width: 200,
    height: 100,
    fingerprint: fingerprint(),
  }]);

  assert.equal(result.catalog_version, 2);
  assert.equal(result.items[0].sha256, 'a'.repeat(64));
  assert.equal(validateVisualIndex(result).items.length, 1);
});

test('visual index rejects the same picture under different bytes and path', () => {
  const existing = buildVisualIndexUpdate(emptyIndex(), 2, [{
    mode: 'new',
    path: 'logos/first/first-primary-v1.png',
    sha256: 'a'.repeat(64),
    width: 200,
    height: 100,
    fingerprint: fingerprint(),
  }]);

  assert.throws(
    () => buildVisualIndexUpdate(existing, 3, [{
      mode: 'new',
      path: 'logos/second/second-primary-v1.webp',
      sha256: 'b'.repeat(64),
      width: 200,
      height: 100,
      fingerprint: fingerprint(31, 81, 159),
    }]),
    (error) => error instanceof VisualIndexError && error.code === 'duplicate_image_visual',
  );
});

test('visual index keeps immutable history unless a file is explicitly purged', () => {
  const existing = buildVisualIndexUpdate(emptyIndex(), 2, [{
    mode: 'new',
    path: 'logos/brand/brand-primary-v1.png',
    sha256: 'a'.repeat(64),
    width: 200,
    height: 100,
    fingerprint: fingerprint(),
  }]);
  const retained = buildVisualIndexUpdate(existing, 3, [{
    mode: 'delete',
    path: 'logos/brand/brand-primary-v1.png',
    purge_file: false,
  }]);
  const purged = buildVisualIndexUpdate(retained, 4, [{
    mode: 'delete',
    path: 'logos/brand/brand-primary-v1.png',
    purge_file: true,
  }]);

  assert.equal(retained.items.length, 1);
  assert.equal(purged.items.length, 0);
});

test('visual index rejects a fingerprint whose aspect ratio does not match file dimensions', () => {
  assert.throws(
    () => buildVisualIndexUpdate(emptyIndex(), 2, [{
      mode: 'new',
      path: 'logos/brand/brand-primary-v1.png',
      sha256: 'a'.repeat(64),
      width: 100,
      height: 100,
      fingerprint: fingerprint(30, 80, 160, 2),
    }]),
    (error) => error.code === 'invalid_visual_fingerprint',
  );
});
