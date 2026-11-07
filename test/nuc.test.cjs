const test = require('node:test');
const assert = require('node:assert/strict');
const { applyNuc } = require('../src/core/nuc.cjs');

const u16 = values => Uint16Array.from(values);

test('offline NUC preserves valid 14-bit counts at Q15 unity with zero background and offset', () => {
  const raw = u16([0, 1, 100, 4096, 10000, 16383]);
  const result = applyNuc({ raw, gain: new Uint16Array(raw.length).fill(32768), background: new Uint16Array(raw.length), offset: 0 });
  assert(result instanceof Uint16Array);
  assert.deepEqual(result, raw);
  assert.notEqual(result, raw);
});

test('offline NUC applies nonuniform Q15 gains and quarter-count backgrounds', () => {
  const raw = u16([1000, 1000, 1000, 1000]);
  const gain = u16([32768, 16384, 49152, 65535]);
  const background = u16([400, 800, 1200, 1600]);
  const before = [raw.slice(), gain.slice(), background.slice()];
  const result = applyNuc({ raw, gain, background, offset: 500 });
  assert.deepEqual(Array.from(result), [1400, 900, 1550, 1699]);
  assert.deepEqual([raw, gain, background], before, 'Inputs must remain unchanged.');
});

test('offline NUC uses arithmetic shift for a negative fractional count', () => {
  const result = applyNuc({ raw: u16([10]), gain: u16([32768]), background: u16([41]), offset: 100 });
  assert.equal(result[0], 99, '-0.25 is shifted down to -1, not truncated toward zero.');
});

test('offline NUC clamps negative and overrange results to 14 bits', () => {
  assert.deepEqual(Array.from(applyNuc({ raw: u16([0, 100]), gain: u16([32768, 32768]), background: u16([400, 0]), offset: 0 })), [0, 100]);
  assert.equal(applyNuc({ raw: u16([500]), gain: u16([32768]), background: u16([0]), offset: 16000 })[0], 16383);
});

test('offline NUC wraps the native signed32 multiply before shifting', () => {
  const raw = u16([16383, 16384, 32768, 65535, 40000, 0]);
  const gain = u16([32768, 32768, 32768, 65535, 60000, 65535]);
  const background = u16([0, 0, 0, 0, 12345, 65535]);
  const offset = 2000;
  const expected = Array.from(raw, (r, i) => {
    const product = BigInt.asIntN(32, ((BigInt(r) << 2n) - BigInt(background[i])) * BigInt(gain[i]));
    const value = BigInt(offset) + (product >> 17n);
    return Number(value < 0n ? 0n : value > 16383n ? 16383n : value);
  });
  assert.deepEqual(Array.from(applyNuc({ raw, gain, background, offset })), expected);
  assert.equal(expected[1], 0, 'Native multiplication overflows for a raw value outside the 14-bit domain.');
});

test('offline NUC honors array views and rejects ambiguous or mismatched data', () => {
  const result = applyNuc({ raw: u16([99, 100, 200, 999]).subarray(1, 3), gain: u16([32768, 32768]), background: u16([0, 0]), offset: 0 });
  assert.deepEqual(Array.from(result), [100, 200]);
  const valid = { raw: u16([1]), gain: u16([32768]), background: u16([0]), offset: 0 };
  for (const field of ['raw', 'gain', 'background']) {
    assert.throws(() => applyNuc({ ...valid, [field]: [1] }), TypeError);
    assert.throws(() => applyNuc({ ...valid, [field]: new Float32Array([1]) }), TypeError);
    assert.throws(() => applyNuc({ ...valid, [field]: new Uint16Array(2) }), RangeError);
  }
  for (const offset of [-1, 65536, 1.5, NaN, Infinity, '1', undefined]) assert.throws(() => applyNuc({ ...valid, offset }), RangeError);
  assert.throws(() => applyNuc({ raw: u16([]), gain: u16([]), background: u16([]), offset: 0 }), RangeError);
  assert.throws(() => applyNuc(), TypeError);
});
