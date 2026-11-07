'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shutterDueReason } = require('../src/core/shutter-schedule.cjs');

function input(overrides = {}) {
  return { nowMs: 12_000, baselineAtMs: 10_000, sensorCounts: 1516,
    baselineSensorCounts: 1516, referenceReady: false, ...overrides };
}

test('F2 host drift uses inclusive 17/25 count boundaries in either direction', () => {
  for (const referenceReady of [false, true]) {
    const boundary = referenceReady ? 25 : 17;
    for (const sign of [-1, 1]) {
      assert.equal(shutterDueReason(input({ referenceReady, sensorCounts: 1516 + sign * (boundary - 1) })), null);
      assert.equal(shutterDueReason(input({ referenceReady, sensorCounts: 1516 + sign * boundary })), 'sensor-drift');
    }
  }
  assert.equal(shutterDueReason(input({ baselineSensorCounts: -10, sensorCounts: 7 })), 'sensor-drift');
});

test('300 seconds is inclusive, independently timed, and never an invented startup trigger', () => {
  assert.equal(shutterDueReason(input({ nowMs: 40_000 })), null);
  assert.equal(shutterDueReason(input({ nowMs: 309_999.999 })), null);
  assert.equal(shutterDueReason(input({ nowMs: 310_000 })), 'interval');
  assert.equal(shutterDueReason(input({ nowMs: 310_000, sensorCounts: null })), 'interval');
  assert.equal(shutterDueReason(input({ nowMs: 310_000, baselineAtMs: null })), null);
  assert.equal(shutterDueReason(input({ nowMs: 310_000, sensorCounts: 1600 })), 'sensor-drift');
});

test('busy/recording guards suppress a due action without mutating baselines', () => {
  for (const guards of [{ busy: true }, { recording: true }, { busy: true, recording: true }]) {
    const state = Object.freeze(input({ nowMs: 310_000, sensorCounts: 1600, ...guards }));
    assert.equal(shutterDueReason(state), null);
    assert.equal(shutterDueReason({ ...state, busy: false, recording: false }), 'sensor-drift');
  }
});

test('invalid metadata cannot cause drift and clock resets cannot cause any trigger', () => {
  for (const sensorCounts of [null, undefined, NaN, Infinity, 8192, -8192, 30.32]) {
    assert.equal(shutterDueReason(input({ sensorCounts })), null);
    assert.equal(shutterDueReason(input({ baselineSensorCounts: sensorCounts, sensorCounts: 1600 })), null);
  }
  assert.equal(shutterDueReason(input({ nowMs: 9_999, sensorCounts: 1600 })), null);
  assert.throws(() => shutterDueReason(input({ nowMs: NaN })), /nowMs/);
  assert.throws(() => shutterDueReason(input({ baselineAtMs: -1 })), /baselineAtMs/);
  assert.throws(() => shutterDueReason(input({ referenceReady: 1 })), /booleans/);
});
