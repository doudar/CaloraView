const test = require('node:test');
const assert = require('node:assert/strict');
const { applyTecLess30 } = require('../src/core/nuc-tecless.cjs');

function input(raw, extra = {}) {
  return { raw: Uint16Array.from(raw), gain: new Uint16Array(raw.length).fill(32768),
    background: new Uint16Array(raw.length), drift: new Int16Array(raw.length),
    sensorDelta: 0, meanDrift: 0, backgroundDrift: 0, offset: 0, ...extra };
}

test('offline TECLESS30 keeps wide products and clips corrected detector values', () => {
  assert.deepEqual([...applyTecLess30(input([0, 1, 16383, 16384, 40000, 65535]))], [0, 1, 16383, 16383, 16383, 16383]);
});

test('offline TECLESS30 applies signed per-pixel drift and optional global correction', () => {
  const value = input([5500, 5500, 5500], { background: Uint16Array.from([22000, 22000, 22000]),
    drift: Int16Array.from([2048, -2048, 0]), sensorDelta: 10,
    meanDrift: 1024, backgroundDrift: 512, offset: 5500 });
  assert.deepEqual([...applyTecLess30(value)], [5492, 5512, 5502]);
  assert.deepEqual([...applyTecLess30({ ...value, globalCompensation: false })], [5490, 5510, 5500]);
  assert.deepEqual([...applyTecLess30({ ...value, sensorDelta: -10 })], [5507, 5487, 5497]);
});

test('offline TECLESS30 preserves negative fractional shifts and input views', () => {
  const buffer = Uint16Array.from([999, 10, 999]);
  const value = input([], { raw: buffer.subarray(1, 2), gain: Uint16Array.from([32768]),
    background: Uint16Array.from([41]), drift: Int16Array.from([1]), offset: 100 });
  assert.deepEqual([...applyTecLess30(value)], [99]);
  assert.deepEqual([...buffer], [999, 10, 999]);
});

test('offline TECLESS30 wraps drift terms at32 bits and global correction at16 bits', () => {
  const value = input([5500], { background: Uint16Array.from([22000]), drift: Int16Array.from([32767]),
    sensorDelta: 65535, meanDrift: 32767, backgroundDrift: -32768, offset: 5500 });
  // Independent integer reference with explicit native width reductions.
  const delta = 65535n;
  const global = BigInt.asIntN(16, BigInt.asUintN(32, delta * 65535n) >> 11n);
  const correction = BigInt.asIntN(32, delta * 4n * 32767n);
  const expected = 5500n + global + ((-correction * 32768n) >> 28n);
  assert.equal(applyTecLess30(value)[0], Number(expected < 0n ? 0n : expected > 16383n ? 16383n : expected));
});

test('offline TECLESS30 rejects incomplete state and mismatched plane types', () => {
  assert.throws(() => applyTecLess30(), TypeError);
  assert.throws(() => applyTecLess30(input([])), RangeError);
  assert.throws(() => applyTecLess30(input([1], { drift: new Uint16Array(1) })), TypeError);
  assert.throws(() => applyTecLess30(input([1], { gain: new Uint16Array(2) })), RangeError);
  for (const extra of [{ sensorDelta: 65536 }, { meanDrift: 32768 }, { backgroundDrift: NaN }, { offset: -1 }]) {
    assert.throws(() => applyTecLess30(input([1], extra)), RangeError);
  }
  assert.throws(() => applyTecLess30(input([1], { globalCompensation: 1 })), TypeError);
});
