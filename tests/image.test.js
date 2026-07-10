import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectImage, ImageValidationError } from '../lib/image.js';

function png(width = 120, height = 60) {
  const bytes = new Uint8Array(57);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([0, 0, 0, 0], 29);
  bytes.set([0, 0, 0, 0], 33); // Empty IDAT.
  bytes.set([73, 68, 65, 84], 37);
  bytes.set([0, 0, 0, 0], 41);
  bytes.set([0, 0, 0, 0], 45);
  bytes.set([73, 69, 78, 68], 49);
  bytes.set([0, 0, 0, 0], 53);
  return bytes;
}

function jpeg(width = 320, height = 180) {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x00,
    0xff, 0xd9,
  ]);
}

function webp(width = 200, height = 100) {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(bytes.buffer).setUint32(4, 22, true);
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  const w = width - 1;
  const h = height - 1;
  bytes.set([0, 0, 0, 0, w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 20);
  return bytes;
}

test('reads PNG, JPEG and WebP dimensions from bytes', () => {
  assert.deepEqual(inspectImage(png()), { mime: 'image/png', extension: 'png', width: 120, height: 60, bytes: 57 });
  assert.deepEqual(inspectImage(jpeg()), { mime: 'image/jpeg', extension: 'jpg', width: 320, height: 180, bytes: 28 });
  assert.deepEqual(inspectImage(webp()), { mime: 'image/webp', extension: 'webp', width: 200, height: 100, bytes: 30 });
});

test('rejects truncated image containers even when dimensions are present', () => {
  assert.throws(() => inspectImage(png().slice(0, 45)), (error) => error.code === 'invalid_png');
  assert.throws(() => inspectImage(jpeg().slice(0, -2)), (error) => error.code === 'invalid_jpeg');
  const brokenWebp = webp();
  new DataView(brokenWebp.buffer).setUint32(4, 100, true);
  assert.throws(() => inspectImage(brokenWebp), (error) => error.code === 'invalid_webp');
});

test('rejects HTML renamed as an image', () => {
  assert.throws(
    () => inspectImage(new TextEncoder().encode('<html><script>alert(1)</script></html>')),
    (error) => error instanceof ImageValidationError && error.code === 'unsupported_image',
  );
});

test('rejects excessive dimensions', () => {
  assert.throws(() => inspectImage(png(6001, 10)), (error) => error.code === 'image_too_wide');
  assert.throws(() => inspectImage(png(5000, 5000)), (error) => error.code === 'image_too_many_pixels');
});

test('rejects Git LFS pointers', () => {
  assert.throws(
    () => inspectImage(new TextEncoder().encode('version https://git-lfs.github.com/spec/v1\noid sha256:test\nsize 1\n')),
    (error) => error.code === 'git_lfs_pointer',
  );
});
