'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareRadiometry, grayToBlackbody, signedSensor } = require('../src/core/radiometry-state.cjs');
const { createRadiometry } = require('../src/core/radiometry.cjs');
// Invented coefficients only; no camera tables or vendor media in fixtures.
function fixture() {
  const calibration = Buffer.alloc(14336), metadata = Buffer.alloc(1024);
  calibration.writeUInt32LE(0x404, 0); calibration.writeUInt32LE(83, 8);
  calibration.write('HM-TJ12-3AAY1F', 16, 'ascii');
  const set = (o, n) => calibration.writeFloatLE(n, o);
  set(0x27f4, 1); set(0x27ec, .02); set(0x50, -100); set(0x64, 500);
  set(0x270, 25); set(0x464, 20); set(0xd20, 1);
  set(0x698, 100000); set(0x69c, 1400); set(0x6a4, 1);
  set(0x28a8, -100); set(0x2898, 100);
  set(0x1eb0, 5); set(0x1eb4, 2); set(0x1eb8, 3);
  set(0x21ac, 1); set(0x21b0, 1100); set(0x21b4, .6);
  metadata.writeUInt16LE(1250, 2); metadata.writeUInt16LE(1, 10);
  metadata.writeUInt16LE(192, 16); metadata.writeUInt16LE(256, 18);
  return { calibration, metadata, set };
}
test('sensor encoding handles positive and negative signed magnitude', () => {
  assert.equal(signedSensor(1500), 1500);
  assert.equal(signedSensor(8193), -1);
  assert.equal(signedSensor(16383), -8191);
  assert.equal(signedSensor(0x4001), 1);
});
test('portable preparation responds to metadata and environmental base-gray drift', () => {
  const { calibration, metadata } = fixture();
  const baseline = prepareRadiometry(calibration, metadata);
  assert.equal(baseline.baseGray, 8192);
  assert.equal(baseline.linear, 1); assert.equal(baseline.quadratic, 0);
  assert.equal(prepareRadiometry(calibration, metadata, { ambientC: 15 }).baseGray, 8177);
  assert.equal(prepareRadiometry(calibration, metadata, { ambientC: 25 }).baseGray, 8202);
  const point = grayToBlackbody(baseline.baseGray, baseline);
  assert.equal(point.status, 0); assert.ok(Math.abs(point.celsius - 25) < .1);
});
test('malformed, ineligible and unsupported frames cannot yield temperature', () => {
  const { calibration, metadata } = fixture();
  for (const i of [6, 7]) {
    const m = Buffer.from(metadata); m.writeUInt16LE(1, i * 2);
    assert.throws(() => prepareRadiometry(calibration, m), /eligible/);
  }
  const busy = Buffer.from(metadata); busy.writeUInt32LE(1, 540);
  assert.throws(() => prepareRadiometry(calibration, busy), /eligible/);
  const unsupported = Buffer.from(metadata); unsupported.writeUInt16LE(2, 10);
  assert.throws(() => prepareRadiometry(calibration, unsupported), /Unsupported/);
  assert.throws(() => prepareRadiometry(Buffer.alloc(10), metadata), /14336/);
  assert.throws(() => prepareRadiometry(calibration, Buffer.alloc(10)), /rows/);
});
test('gray conversion rejects invalid input and reports clamp status', () => {
  const state = { linear: 1, quadratic: 0, baseGray: 8192, planck: { a: 100000, b: 1400, c: -1000, d: 1 }, minimumC: 0, maximumC: 50 };
  for (const g of [-1, 16384, NaN, 10.5]) assert.deepEqual(grayToBlackbody(g, state), { status: -19, celsius: null });
  assert.equal(grayToBlackbody(7000, state).status, -19);
  assert.equal(grayToBlackbody(7250, state).status, -301);
  assert.equal(grayToBlackbody(16000, state).status, -300);
});
test('frame summary uses global converted extrema and detector coordinates', () => {
  const { calibration, metadata } = fixture();
  const processor = createRadiometry(calibration, { serial: 'synthetic-camera' });
  const detector = new Uint16Array(256 * 192).fill(8192);
  detector[23 * 256 + 14] = 9000; detector[12 * 256 + 34] = 8000;
  const result = processor.evaluate(detector, metadata);
  assert.equal(result.calibration.status, 'factory-calibrated');
  assert.equal(result.calibration.absoluteAccuracyValidated, false);
  assert.deepEqual([result.temperatures.highX, result.temperatures.highY], [14, 23]);
  assert.deepEqual([result.temperatures.lowX, result.temperatures.lowY], [34, 12]);
  assert.ok(result.temperatures.high > result.temperatures.center);
  assert.ok(result.temperatures.center > result.temperatures.low);
  assert.deepEqual(processor.evaluate(detector, metadata), result);
});
test('an invalid pixel prevents silently incomplete image extrema', () => {
  const { calibration, metadata } = fixture();
  const processor = createRadiometry(calibration, { serial: 'synthetic-camera' });
  const detector = new Uint16Array(256 * 192).fill(8192); detector[0] = 65535;
  const result = processor.evaluate(detector, metadata);
  assert.equal(result.temperatures, null); assert.equal(result.calibration.status, 'out-of-range');
  assert.equal(result.calibration.invalidPixels, 1);
  assert.equal(processor.evaluate(new Uint16Array(10), metadata).temperatures, null);
  assert.throws(() => createRadiometry(calibration, { serial: '' }), /serial/);
});
test('valid, shutter-busy, missing-sensor and recovered frames never leak stale temperatures', () => {
  const { calibration, metadata } = fixture();
  const processor = createRadiometry(calibration, { serial: 'synthetic-camera' });
  const detector = new Uint16Array(256 * 192).fill(8192);
  const expected = processor.evaluate(detector, metadata).temperatures;
  assert.ok(expected);
  const shutter = Buffer.from(metadata); shutter.writeUInt16LE(1, 12);
  assert.equal(processor.evaluate(detector, shutter).temperatures, null);
  const absent = Buffer.from(metadata); absent.writeUInt16LE(0, 2);
  assert.equal(processor.evaluate(detector, absent).temperatures, null);
  assert.deepEqual(processor.evaluate(detector, metadata).temperatures, expected);
});
