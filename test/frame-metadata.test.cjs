'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROFILE } = require('../src/core/thermal.cjs');
const { CAV_OFFSET, decodeSensorWord, readFrameMetadata } = require('../src/core/frame-metadata.cjs');

test('CAV reads row 216 word 1 without mistaking image or adjacent metadata for the sensor', () => {
  const frame = Buffer.alloc(PROFILE.frameBytes, 0x55);
  frame.writeUInt16LE(1516, 216 * 528 + 2);
  const before = Buffer.from(frame);
  assert.equal(CAV_OFFSET, 114050);
  assert.deepEqual(readFrameMetadata(frame), {
    source: 'f2-additional-cav-word1', sensorRaw: 1516,
    sensorCounts: 1516, sensorUnits: 30.32, valid: true,
  });
  assert.deepEqual(frame, before);
});

test('sensor sign encoding matches native 8192-minus-word conversion', () => {
  for (const [raw, expected] of [[0, 0], [8191, 8191], [8192, 0], [8193, -1], [16383, -8191]]) {
    assert.equal(decodeSensorWord(raw), expected);
  }
  const frame = Buffer.alloc(PROFILE.frameBytes);
  frame.writeUInt16LE(8242, CAV_OFFSET);
  assert.equal(readFrameMetadata(frame).sensorCounts, -50);
  assert.equal(readFrameMetadata(frame).sensorUnits, -1);
});

test('missing and unsupported sensor metadata cannot trigger drift from zero or guessed flags', () => {
  const frame = Buffer.alloc(PROFILE.frameBytes);
  for (const raw of [0, 0x4000, 0xffff]) {
    frame.writeUInt16LE(raw, CAV_OFFSET);
    const metadata = readFrameMetadata(frame);
    assert.equal(metadata.valid, false);
    assert.equal(metadata.sensorCounts, null);
    assert.equal(metadata.sensorUnits, null);
  }
  assert.throws(() => readFrameMetadata(frame.subarray(1)), /Expected one/);
  assert.throws(() => readFrameMetadata(new Uint8Array(PROFILE.frameBytes)), /Expected one/);
  for (const value of [-1, 16384, 0.5, NaN]) assert.throws(() => decodeSensorWord(value), RangeError);
});
