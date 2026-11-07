'use strict';

/**
 * OFFLINE RESEARCH HELPER — not connected to the live camera pipeline.
 *
 * Reproduces one scalar branch of libifrnuc.so's NUC_Process, ARM64 virtual
 * addresses 0x1f13c–0x1f168, with its optional secondary output limiter disabled.
 * The branch has NOT been established as the SK02's selected algorithm. It
 * produces corrected detector counts, never Celsius. See docs/nuc-investigation.md.
 *
 * K is unsigned Q15 (32768 = unity). B is a uint16 quarter-count background.
 * The native multiply is 32-bit and wraps before its arithmetic right shift.
 * Ordinary floating-point division, or a wide multiply without that wrap,
 * does not reproduce this branch at overflow boundaries or negative fractions.
 */
function applyNuc({ raw, gain, background, offset } = {}) {
  for (const [name, data] of Object.entries({ raw, gain, background })) {
    if (!(data instanceof Uint16Array)) throw new TypeError(`${name} must be a Uint16Array.`);
  }
  if (!raw.length || gain.length !== raw.length || background.length !== raw.length) {
    throw new RangeError('raw, gain, and background must have the same nonzero length.');
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 65535) {
    throw new RangeError('offset must be an unsigned 16-bit integer.');
  }
  const corrected = new Uint16Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const difference = ((raw[i] << 2) - background[i]) | 0;
    const value = (offset + (Math.imul(difference, gain[i]) >> 17)) | 0;
    corrected[i] = Math.min(16383, Math.max(0, value));
  }
  return corrected;
}

module.exports = { applyNuc };
