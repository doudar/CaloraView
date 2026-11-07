const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { summarizeAcceptedShutterFrames: summarize } = require('../src/core/shutter-background.cjs');
const fixture = () => ({ frames: Array.from({ length: 16 }, (_, n) => Uint16Array.of(100 + n % 3, 65535)), sensorSamples: new Int16Array(16).fill(-101), baselineSource: 'acquisition' });

test('shutter quarter-count background retains fractional raw counts before uint16 narrowing', () => {
  const input = fixture(), result = summarize(input);
  assert.deepEqual([...result.sum], [1615, 1048560]);
  assert.deepEqual([...result.reference], [100, 65535]);
  assert.deepEqual([...result.backgroundQuarter], [403, 65532]);
  assert.equal(result.imageMean, 8242);
  assert.equal(result.sensorBaseline, -101);
  assert.equal(input.frames[0][0], 100);
});
test('baseline uses the eighth sample, three-unit rejection and truncation toward zero', () => {
  const input = fixture(); input.sensorSamples[0] = -99; input.sensorSamples[1] = -98;
  const result = summarize(input);
  assert.equal(result.filteredSensorSamples[0], -99);
  assert.equal(result.filteredSensorSamples[1], -101);
  assert.equal(result.sensorBaseline, -100);
});
test('history-tail override is explicit and does not reuse acquisition outlier filtering', () => {
  const input = fixture(); input.baselineSource = 'history-tail'; input.sensorHistory = new Int16Array(32).fill(1);
  input.sensorHistory.fill(300, 16); input.sensorHistory[31] = 316;
  assert.equal(summarize(input).sensorBaseline, 301);
});
test('reject incomplete acquisition, missing branch state and mismatched planes', () => {
  assert.throws(() => summarize({ ...fixture(), frames: fixture().frames.slice(1) }));
  assert.throws(() => summarize({ ...fixture(), baselineSource: undefined }));
  assert.throws(() => summarize({ ...fixture(), baselineSource: 'history-tail' }));
  const input = fixture(); input.frames[4] = Uint16Array.of(1); assert.throws(() => summarize(input));
});
const oraclePath = path.join(__dirname, '../research/shutter-background-synthetic-vectors.json');
test('matches locally generated ARM64 native acquisition vectors', { skip: !fs.existsSync(oraclePath) }, () => {
  for (const vector of JSON.parse(fs.readFileSync(oraclePath, 'utf8'))) {
    const actual = summarize({ ...vector, frames: vector.frames.map(frame => Uint16Array.from(frame)),
      sensorSamples: Int16Array.from(vector.sensorSamples), sensorHistory: Int16Array.from(vector.sensorHistory) });
    for (const key of ['sum', 'reference', 'backgroundQuarter']) assert.deepEqual([...actual[key]], vector.expected[key]);
    for (const key of ['sensorBaseline', 'imageMean']) assert.equal(actual[key], vector.expected[key]);
  }
});

test('eight-frame acquisition uses fourth sensor anchor and quarter scaling', () => {
  const input = fixture(); input.referenceCount = 8; input.frames = input.frames.slice(0, 8);
  input.sensorSamples = Int16Array.from([-99, -98, -101, -101, -101, -101, -101, 200]);
  const result = summarize(input);
  assert.deepEqual([...result.sum], [807, 524280]);
  assert.deepEqual([...result.reference], [100, 65535]);
  assert.deepEqual([...result.backgroundQuarter], [403, 65532]);
  assert.equal(result.imageMean, 8242);
  assert.deepEqual([...result.filteredSensorSamples], [-99, -101, -101, -101, -101, -101, -101, -101]);
  assert.equal(result.sensorBaseline, -100);
  assert.equal(input.sensorSamples[7], 200);
  assert.throws(() => summarize({ ...input, referenceCount: 16 }), /16/);
  assert.throws(() => summarize({ ...input, referenceCount: 4 }), /8 or 16/);
});

test('eight-frame history branch uses the final eight of32 entries', () => {
  const input = fixture(); input.referenceCount = 8; input.frames = input.frames.slice(0, 8);
  input.sensorSamples = input.sensorSamples.slice(0, 8); input.baselineSource = 'history-tail';
  input.sensorHistory = new Int16Array(32).fill(1); input.sensorHistory.fill(300, 24); input.sensorHistory[31] = 308;
  assert.equal(summarize(input).sensorBaseline, 301);
});

const eightOraclePath = path.join(__dirname, '../research/shutter-background-eight-synthetic-vectors.json');
test('matches native eight-frame background and CAV baselines including signed wrap', { skip: !fs.existsSync(eightOraclePath) }, () => {
  for (const vector of JSON.parse(fs.readFileSync(eightOraclePath, 'utf8'))) {
    const actual = summarize({ ...vector, frames: vector.frames.map(frame => Uint16Array.from(frame)),
      sensorSamples: Int16Array.from(vector.sensorSamples), sensorHistory: Int16Array.from(vector.sensorHistory) });
    for (const key of ['sum', 'reference', 'backgroundQuarter']) assert.deepEqual([...actual[key]], vector.expected[key]);
    for (const key of ['sensorBaseline', 'imageMean']) assert.equal(actual[key], vector.expected[key]);
  }
});
