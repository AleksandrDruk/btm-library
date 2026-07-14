import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { visualFingerprintsMatch } from '../lib/visual-dedupe.js';
import { validateVisualIndex } from '../lib/visual-index.js';

test('bootstrap visual index has no perceptual collisions between distinct logos', async () => {
  const index = validateVisualIndex(JSON.parse(await readFile(
    new URL('../visual-index.json', import.meta.url),
    'utf8',
  )));
  for (let left = 0; left < index.items.length; left += 1) {
    for (let right = left + 1; right < index.items.length; right += 1) {
      assert.equal(
        visualFingerprintsMatch(index.items[left].fingerprint, index.items[right].fingerprint),
        false,
        `${index.items[left].path} collides with ${index.items[right].path}`,
      );
    }
  }
});
