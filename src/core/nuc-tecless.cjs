'use strict';

/**
 * Offline research only: enabled TECLESS30 drift-compensation pixel branch.
 * Verified against ARM64 libifrnuc.so 0x1f71c–0x1f820 with synthetic inputs.
 * Requires already selected per-gear maps and filtered sensor delta. Does not
 * construct shutter state, filter sensors, select gears, or calculate Celsius.
 * Gain bypass and the optional secondary output limiter are not represented.
 */
function applyTecLess30({ raw, gain, background, drift, sensorDelta, meanDrift,
  backgroundDrift, offset, globalCompensation = true } = {}) {
  for (const [name, data] of Object.entries({ raw, gain, background })) {
    if (!(data instanceof Uint16Array)) throw new TypeError(`${name} must be a Uint16Array.`);
  }
  if (!(drift instanceof Int16Array)) throw new TypeError('drift must be an Int16Array.');
  if (!raw.length || [gain, background, drift].some(data => data.length !== raw.length)) {
    throw new RangeError('All planes must have the same nonzero length.');
  }
  for (const [name, value, low, high] of [
    ['sensorDelta', sensorDelta, -65535, 65535],
    ['meanDrift', meanDrift, -32768, 32767],
    ['backgroundDrift', backgroundDrift, -32768, 32767],
    ['offset', offset, 0, 65535],
  ]) {
    if (!Number.isInteger(value) || value < low || value > high) {
      throw new RangeError(`${name} must be an integer from ${low} to ${high}.`);
    }
  }
  if (typeof globalCompensation !== 'boolean') throw new TypeError('globalCompensation must be boolean.');

  // Native: wrapped32 multiply, logical shift11, then sign-extend low16.
  const shifted = Math.imul(sensorDelta, meanDrift - backgroundDrift) >>> 11;
  const globalTerm = globalCompensation ? (shifted << 16) >> 16 : 0;
  const base = BigInt(offset + globalTerm);
  const result = new Uint16Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const driftProduct = Math.imul(sensorDelta << 2, drift[i]);
    const difference = (BigInt(raw[i]) << 13n) - (BigInt(background[i]) << 11n) - BigInt(driftProduct);
    // This branch multiplies in signed64. Validated inputs cannot overflow64.
    const value = base + ((difference * BigInt(gain[i])) >> 28n);
    result[i] = value < 0n ? 0 : value > 16383n ? 16383 : Number(value);
  }
  return result;
}

module.exports = { applyTecLess30 };
