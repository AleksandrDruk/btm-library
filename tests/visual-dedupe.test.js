import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVisualFingerprints,
  createVisualFingerprint,
  VISUAL_SAMPLE_SIZE,
  visualFingerprintsMatch,
} from '../lib/visual-dedupe.js';

function rgba(red, green, blue) {
  const pixels = new Uint8ClampedArray(VISUAL_SAMPLE_SIZE * VISUAL_SAMPLE_SIZE * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = 255;
  }
  return pixels;
}

test('visual fingerprint matches the same decoded image independently of its file container', () => {
  const pixels = rgba(40, 90, 180);
  const pngFingerprint = createVisualFingerprint(pixels, 2);
  const webpFingerprint = createVisualFingerprint(new Uint8ClampedArray(pixels), 2);

  assert.equal(visualFingerprintsMatch(pngFingerprint, webpFingerprint), true);
});

test('visual fingerprint tolerates small compression noise', () => {
  const original = rgba(93, 93, 93);
  const compressed = new Uint8ClampedArray(original);
  for (let offset = 0; offset < compressed.length; offset += 4) {
    compressed[offset] += offset % 8 === 0 ? 2 : -2;
    compressed[offset + 1] += offset % 8 === 0 ? -2 : 2;
  }

  const result = compareVisualFingerprints(
    createVisualFingerprint(original, 1.5),
    createVisualFingerprint(compressed, 1.5),
  );
  assert.equal(result.match, true);
  assert.ok(result.rms_channel_delta > 0);
});

test('visual fingerprint tolerates one isolated compression outlier', () => {
  const original = rgba(34, 34, 34);
  const compressed = new Uint8ClampedArray(original);
  compressed[0] = 85;
  compressed[1] = 85;
  compressed[2] = 85;

  const result = compareVisualFingerprints(
    createVisualFingerprint(original, 1),
    createVisualFingerprint(compressed, 1),
  );
  assert.equal(result.match, true);
  assert.equal(result.max_channel_delta, 3);
  assert.ok(result.rms_channel_delta < 0.35);
});

test('visual fingerprint rejects distributed low-contrast layout changes', () => {
  const blank = rgba(0, 0, 0);
  const changed = new Uint8ClampedArray(blank);
  for (let pixel = 0; pixel < 20; pixel += 1) {
    const offset = pixel * 4;
    changed[offset] = 51;
    changed[offset + 1] = 51;
    changed[offset + 2] = 51;
  }

  const result = compareVisualFingerprints(
    createVisualFingerprint(blank, 1),
    createVisualFingerprint(changed, 1),
  );
  assert.equal(result.match, false);
  assert.equal(result.max_channel_delta, 3);
  assert.ok(result.rms_channel_delta > 0.35);
  assert.ok(result.rms_channel_delta < 1);
});

test('visual fingerprint does not hide a small high-contrast mark', () => {
  const blank = rgba(255, 255, 255);
  const marked = new Uint8ClampedArray(blank);
  marked[0] = 0;
  marked[1] = 0;
  marked[2] = 0;

  const result = compareVisualFingerprints(
    createVisualFingerprint(blank, 1),
    createVisualFingerprint(marked, 1),
  );
  assert.equal(result.match, false);
  assert.equal(result.max_channel_delta, 15);
});

test('visual fingerprint keeps different color variants distinct', () => {
  const light = createVisualFingerprint(rgba(235, 235, 235), 2);
  const dark = createVisualFingerprint(rgba(25, 25, 25), 2);

  assert.equal(visualFingerprintsMatch(light, dark), false);
});

test('visual fingerprint rejects materially different aspect ratios', () => {
  const pixels = rgba(40, 90, 180);
  const horizontal = createVisualFingerprint(pixels, 2);
  const square = createVisualFingerprint(pixels, 1);

  assert.equal(visualFingerprintsMatch(horizontal, square), false);
});
