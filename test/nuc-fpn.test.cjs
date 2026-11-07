'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { correctFixedPattern } = require('../src/core/nuc-fpn.cjs');
const references = require('./fixtures/nuc-fpn-reference.json');
function scene(kind) {
  const image = new Uint16Array(256 * 192);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const base = 5500 + Math.floor(x / 32) * 100 + Math.floor(y / 48) * 40;
    image[y * 256 + x] = [base, base + x % 7 - 3, base + (x * 7 + y * 11) % 23 - 11,
      base + (x * 29 + y * 43) % 601 - 300, (x * 157 + y * 71) % 16384,
      (x % 2) * 16383, (x + y) % 9, 16375 + (x + y) % 9][kind];
  }
  return image;
}
test('four-band FPN matches native output for 393216 synthetic pixels including edges and clipping', () => {
  for (const reference of references) {
    const image = scene(reference.case), original = image.slice();
    const { corrected, coefficients } = correctFixedPattern(image);
    assert.equal(createHash('sha256').update(Buffer.from(corrected.buffer)).digest('hex'), reference.sha256, `scene ${reference.case}`);
    assert.deepEqual(image, original);
    assert.equal(coefficients.length, 1024);
  }
});
test('FPN rejects incompatible geometry and parameters', () => {
  assert.throws(() => correctFixedPattern(new Uint16Array(5)), /complete image/);
  assert.throws(() => correctFixedPattern(scene(0), { shift: -1 }), /parameters/);
});
