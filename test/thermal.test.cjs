'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROFILE, FrameAssembler, decodeFrame, makeFlatField, palettes } = require('../src/core/thermal.cjs');

function frame(value = 10000) {
  const data = Buffer.alloc(PROFILE.frameBytes);
  for (let i = 0; i < data.length; i += 2) data.writeUInt16LE(value, i);
  return data;
}

function setPixel(data, x, y, value) {
  data.writeUInt16LE(value, ((y + PROFILE.cropY) * PROFILE.width + x + PROFILE.cropX) * 2);
}

test('assembles multiple exact frames across arbitrary and odd-byte chunk boundaries', () => {
  const a = frame(1234), b = frame(65432), c = frame(8000);
  const all = Buffer.concat([a, b, c]);
  const assembler = new FrameAssembler();
  const received = [];
  for (let offset = 0; offset < all.length; offset += 7777) {
    received.push(...assembler.push(all.subarray(offset, offset + 7777)));
    assert.ok(assembler.pendingBytes < PROFILE.frameBytes);
  }
  assert.equal(assembler.pendingBytes, 0);
  assert.deepEqual(received, [a, b, c]);
});

test('assembler owns completed frames and remainder, and reset discards partial data', () => {
  const assembler = new FrameAssembler(4);
  const input = Buffer.from([1, 2, 3, 4, 5]);
  const [first] = assembler.push(input);
  input.fill(0);
  assert.deepEqual(first, Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(assembler.push(Buffer.from([6, 7, 8]))[0], Buffer.from([5, 6, 7, 8]));
  assembler.push(Buffer.from([9]));
  assembler.reset();
  assert.equal(assembler.pendingBytes, 0);
  assert.deepEqual(assembler.push(Buffer.alloc(0)), []);
  assert.throws(() => new FrameAssembler(0), /positive integer/);
  assert.throws(() => assembler.push('text'), /Buffer or Uint8Array/);
});

test('cropping excludes border and metadata, decodes little endian, and reports correct coordinates', () => {
  assert.equal(PROFILE.cropX, 4);
  assert.equal(PROFILE.cropY, 2);
  assert.equal((PROFILE.cropY * PROFILE.width + PROFILE.cropX) * 2, 0x428);
  const data = frame(65535); // All outside-crop words must be ignored.
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) setPixel(data, x, y, 0x1234);
  setPixel(data, 8, 17, 100);
  setPixel(data, 250, 188, 50000);
  setPixel(data, 128, 96, 23456);
  const result = decodeFrame(data);
  assert.equal(result.width, 256);
  assert.equal(result.height, 192);
  assert.equal(result.detector[0], 0x1234);
  assert.equal(result.detector.at(-1), 0x1234);
  assert.deepEqual(result.stats, { center: 23456, high: 50000, low: 100, highX: 250, highY: 188, lowX: 8, lowY: 17 });
  assert.equal(result.temperatures, null);
});

test('flat field averages frames and changes only the preview, never raw statistics or detector values', () => {
  const first = frame(8000), second = frame(10000);
  setPixel(first, 10, 20, 12000);
  setPixel(second, 10, 20, 14000);
  const flatField = makeFlatField([first, second]);
  assert.equal(flatField[0], 9000);
  assert.equal(flatField[20 * 256 + 10], 13000);
  const original = decodeFrame(first, { palette: 'gray' });
  const corrected = decodeFrame(first, { flatField, palette: 'gray' });
  assert.deepEqual(corrected.stats, original.stats);
  assert.deepEqual(corrected.detector, original.detector);
  assert.equal(corrected.temperatures, null);
  assert.equal(corrected.rgba[0], corrected.rgba[(20 * 256 + 10) * 4]);
});

test('all palettes produce opaque valid RGBA, including an entirely uniform frame', () => {
  const data = frame(10000);
  for (const palette of Object.keys(palettes)) {
    const result = decodeFrame(data, { palette });
    assert.equal(result.rgba.length, 256 * 192 * 4);
    for (let i = 0; i < result.rgba.length; i += 4) {
      assert.deepEqual(result.rgba.subarray(i, i + 4), result.rgba.subarray(0, 4));
      assert.equal(result.rgba[i + 3], 255);
    }
  }
});

test('percentile scaling resists isolated outliers while raw extrema remain intact', () => {
  const data = frame(10000);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) setPixel(data, x, y, 10000 + x * 10);
  setPixel(data, 0, 0, 0);
  setPixel(data, 255, 191, 65535);
  const result = decodeFrame(data, { palette: 'gray' });
  assert.ok(result.displayRange.low >= 10000);
  assert.ok(result.displayRange.high <= 12550);
  assert.equal(result.stats.high, 65535);
  assert.equal(result.stats.low, 0);
  assert.equal(result.rgba[0], 0);
  assert.equal(result.rgba.at(-4), 255);
});

test('malformed frames, calibration arrays, and unknown palettes are rejected', () => {
  assert.throws(() => decodeFrame(Buffer.alloc(10)), /Expected 117216/);
  assert.throws(() => decodeFrame(Buffer.alloc(PROFILE.frameBytes + 1)), /Expected 117216/);
  assert.throws(() => decodeFrame(frame(), { palette: '__proto__' }), /Unknown palette/);
  assert.throws(() => decodeFrame(frame(), { flatField: [] }), /Flat field/);
  assert.throws(() => decodeFrame(frame(), { flatField: new Float32Array(3) }), /Flat field/);
  const invalid = new Float32Array(256 * 192);
  invalid[6] = NaN;
  assert.throws(() => decodeFrame(frame(), { flatField: invalid }), /invalid detector value/);
  assert.throws(() => makeFlatField([]), /At least one/);
  assert.throws(() => makeFlatField([Buffer.alloc(3)]), /Expected 117216/);
});


test('factory preview preserves original detector measurements and avoids double flat-field correction', () => {
  const raw = frame(9000);
  setPixel(raw, 12, 15, 14000);
  const factoryPlane = Uint16Array.from({length:256*192}, (_,i) => 7000 + i % 256);
  const flatField = new Float32Array(256*192).fill(8000); flatField[0] = 14000;
  const original = decodeFrame(raw);
  const corrected = decodeFrame(raw, {factoryPlane,flatField,palette:'gray'});
  assert.deepEqual(corrected.stats, original.stats);
  assert.deepEqual(corrected.detector, original.detector);
  assert.equal(corrected.temperatures, null);
  assert(corrected.displayRange.low >= 7000 && corrected.displayRange.high <= 7255);
  assert.equal(corrected.rgba[0], corrected.rgba[256*4]);
  assert.throws(() => decodeFrame(raw, {factoryPlane:new Uint16Array(4)}), /complete corrected/);
});
