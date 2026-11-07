'use strict';

// Decouples temperature sampling from video cadence. Scheduling uses a monotonic
// clock; wall time and frame sequence identify the actual sampled frame only.
class TemperatureSampler {
  constructor({ intervalMs = 500 } = {}) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('Temperature sampling interval must be positive and finite.');
    this.intervalMs = intervalMs;
    this.reset();
  }
  reset() {
    this.nextDue = null;
    this.lastMonotonic = null;
    this.measurement = null;
    this.provenance = null;
  }
  sample({ monotonicMs, timestamp, sequence, available, evaluate, unavailable } = {}) {
    if (!Number.isFinite(monotonicMs) || monotonicMs < 0 || !Number.isFinite(timestamp)
        || !Number.isSafeInteger(sequence) || sequence < 0 || typeof available !== 'boolean') {
      throw new TypeError('Temperature sampling requires valid clocks, sequence and availability.');
    }
    // A different monotonic clock origin means a new sampling epoch. Never hold
    // values indefinitely because a new stream's clock starts near zero.
    if (this.lastMonotonic !== null && monotonicMs < this.lastMonotonic) this.reset();
    const stalled = this.lastMonotonic !== null && monotonicMs - this.lastMonotonic >= this.intervalMs;
    this.lastMonotonic = monotonicMs;
    const fresh = this.nextDue === null || monotonicMs >= this.nextDue;
    let measurement;
    if (!available) {
      measurement = structuredClone(unavailable || { calibration: { status: 'unavailable', reason: 'Temperature measurement is unavailable.' } });
      if (!measurement || typeof measurement !== 'object' || Array.isArray(measurement)) throw new TypeError('Unavailable measurement must be an object.');
      measurement.temperatures = null;
      // An inconsistent caller must not leave a calibrated label on invalid data.
      measurement.calibration = { ...measurement.calibration };
      if (!measurement.calibration.status || measurement.calibration.status === 'factory-calibrated') measurement.calibration.status = 'unavailable';
    } else if (fresh) {
      if (typeof evaluate !== 'function') throw new TypeError('Available temperature samples require an evaluator.');
      measurement = structuredClone(evaluate());
      if (!measurement || typeof measurement !== 'object' || Array.isArray(measurement)
          || !Object.hasOwn(measurement, 'temperatures') || !measurement.calibration) throw new TypeError('Temperature evaluator must return a measurement.');
    }
    if (measurement) this.measurement = measurement;
    if (fresh) {
      this.provenance = { timestamp, monotonicMs, sequence };
      if (this.nextDue === null || stalled) this.nextDue = monotonicMs + this.intervalMs;
      else {
        // Advance past the current frame while retaining the original phase.
        // Ordinary video-frame jitter does not lower the average sample rate.
        // A full-interval stream stall above starts a fresh phase, preventing
        // another sample immediately after a late frame near the old deadline.
        const intervals = Math.floor((monotonicMs - this.nextDue) / this.intervalMs) + 1;
        this.nextDue += intervals * this.intervalMs;
      }
    }
    // Each consumer owns its returned object. In particular adding a reference
    // identifier or changing UI fields cannot mutate future held measurements.
    return { ...structuredClone(this.measurement), measurementSample: { ...this.provenance, fresh } };
  }
}
module.exports = { TemperatureSampler };
