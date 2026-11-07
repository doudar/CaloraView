'use strict';

// Pure, offline policy comparison only. The application does not wire this to
// controls. These comparisons are not the native NUC state machine: eligibility,
// successful-reference baseline updates, retry policy, and shutter recovery must
// be handled by an integrating controller. See docs/frame-metadata-investigation.md.
const F2_SHUTTER_POLICY = Object.freeze({
  intervalMs: 300_000,
  initialDriftCounts: 17,
  referenceReadyDriftCounts: 25,
});

function isSensorCount(value) {
  return Number.isInteger(value) && value >= -8191 && value <= 8191;
}

/**
 * Return 'sensor-drift', 'interval', or null. Sensor inputs are validated signed
 * CAV counts from readFrameMetadata, not Celsius or raw detector image counts.
 * Times must come from one monotonic clock. A null baseline means uninitialized.
 * referenceReady summarizes the native matching gear/type readiness conditions;
 * obtaining that state is outside this helper. busy/recording are app guards,
 * not claimed APK policy. No invocation updates or resets the supplied baseline.
 */
function shutterDueReason({
  nowMs,
  baselineAtMs,
  sensorCounts,
  baselineSensorCounts,
  referenceReady,
  busy = false,
  recording = false,
} = {}) {
  if (typeof referenceReady !== 'boolean' || typeof busy !== 'boolean' || typeof recording !== 'boolean') {
    throw new TypeError('referenceReady, busy and recording must be booleans');
  }
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new RangeError('nowMs must be a nonnegative monotonic timestamp');
  if (busy || recording) return null;
  if (baselineAtMs == null) return null;
  if (!Number.isFinite(baselineAtMs) || baselineAtMs < 0) throw new RangeError('baselineAtMs must be a nonnegative monotonic timestamp or null');
  // Clock reset or mismatched clock origins cannot establish elapsed time.
  if (nowMs < baselineAtMs) return null;
  const threshold = referenceReady
    ? F2_SHUTTER_POLICY.referenceReadyDriftCounts
    : F2_SHUTTER_POLICY.initialDriftCounts;
  if (isSensorCount(sensorCounts) && isSensorCount(baselineSensorCounts)
      && Math.abs(sensorCounts - baselineSensorCounts) >= threshold) {
    return 'sensor-drift';
  }
  // Missing sensor metadata disables drift only; time has its own valid baseline.
  if (nowMs - baselineAtMs >= F2_SHUTTER_POLICY.intervalMs) return 'interval';
  return null;
}

module.exports = { F2_SHUTTER_POLICY, shutterDueReason };
