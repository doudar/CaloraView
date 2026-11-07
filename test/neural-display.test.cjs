'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PROFILE, decodeFrame, colorizeGray } = require('../src/core/thermal.cjs');
const { transformPreview } = require('../src/core/display-transform.cjs');
test('grayscale enhancement preserves native temperature data and applies palette after inference', () => {
  const raw = Buffer.alloc(PROFILE.frameBytes);
  for (let i = 0; i < raw.length; i += 2) raw.writeUInt16LE((i / 2) % 16000, i);
  const originalRaw = Buffer.from(raw);
  const decoded = decodeFrame(raw, { palette: 'iron' });
  assert.deepEqual(colorizeGray(decoded.displayGray, 'iron'), decoded.rgba);
  const temperatures = { center: 25, high: 30, low: 20, highX: 10, highY: 5, lowX: 230, lowY: 170 };
  const native = { ...decoded, temperatures, calibration: { status: 'factory-calibrated' } };
  const enhanced = { width: 512, height: 384, rgba: colorizeGray(new Float32Array(512*384).fill(.5), 'iron'),
    method: 'realesrgan-x4v3-display', model: 'Real-ESRGAN compact', provider: 'test', modelSha256: 'fixture' };
  const frame = transformPreview(native, { resolution: 'enhanced', rotation: 90, enhanced });
  assert.equal(frame.width, 384); assert.equal(frame.height, 512);
  assert.equal(frame.temperatures, temperatures); assert.equal(frame.detector, decoded.detector);
  assert.equal(frame.stats, decoded.stats); assert.equal(frame.displayTransform.modelSha256, 'fixture');
  assert.deepEqual(frame.displayMarkers.high, { x: 372.5, y: 20.5 });
  assert.equal(frame.displayTransform.method, 'realesrgan-x4v3-display');
  assert.deepEqual(raw, originalRaw);
  assert.throws(() => transformPreview(native, { resolution: 'native', enhanced }), /Invalid enhanced/);
  assert.throws(() => transformPreview(native, { resolution: 'enhanced', enhanced: { ...enhanced, width: 384 } }), /Invalid enhanced/);
  assert.throws(() => colorizeGray(new Float32Array([NaN])), /nonfinite/);
});
