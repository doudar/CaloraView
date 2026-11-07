'use strict';

// Optional research check after nuc-tecless-oracle.py; uses synthetic data only.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { applyTecLess30 } = require('../../src/core/nuc-tecless.cjs');
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '../../research/nuc-tecless-synthetic-vectors.json'), 'utf8'));
let pixels = 0;
for (const [index, vector] of vectors.entries()) {
  const result = applyTecLess30({ ...vector,
    raw: Uint16Array.from(vector.raw), gain: Uint16Array.from(vector.gain),
    background: Uint16Array.from(vector.background), drift: Int16Array.from(vector.drift),
  });
  assert.deepEqual([...result], vector.expected, `Native oracle case ${index}`);
  pixels += result.length;
}
console.log(`Matched ${vectors.length} native synthetic cases / ${pixels} pixels.`);
