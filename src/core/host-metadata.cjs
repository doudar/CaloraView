'use strict';

// Byte-for-byte port of selected MicroDM header writes,
// NOT a complete radiometry pipeline. See docs/host-metadata-normalization.md.
const FRAME_BYTES = 264 * 222 * 2;
const ROW_BYTES = 256 * 2;
const COMPACT_BYTES = ROW_BYTES * 6;
const SENSOR_ID = '065356A000';

function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in ${min}..${max}`);
  }
}

function checkCompact(compact) {
  if (!Buffer.isBuffer(compact) || compact.length !== COMPACT_BYTES) {
    throw new RangeError(`Expected all six compact additional rows (${COMPACT_BYTES} bytes)`);
  }
}

function extractCompactAdditional(frame) {
  if (!Buffer.isBuffer(frame) || frame.length !== FRAME_BYTES) {
    throw new RangeError(`Expected one ${FRAME_BYTES}-byte SK02 frame`);
  }
  const output = Buffer.alloc(COMPACT_BYTES);
  for (let row = 0; row < 6; row++) {
    const source = (216 + row) * 528;
    frame.copy(output, row * ROW_BYTES, source, source + ROW_BYTES);
  }
  return output;
}

function rewriteSk02HostHeader(compact, state = {}) {
  checkCompact(compact);
  const { sensorIdentity, fpaWord, cachedCavWord, processorSelector } = state;
  // This identifies the processor enum, not the camera serial. A separate
  // export validator must enforce that calibration belongs to the camera.
  if (sensorIdentity !== SENSOR_ID) throw new Error('Unsupported sensor identity');
  integer(fpaWord, 0, 0xffff, 'fpaWord');
  integer(cachedCavWord, 1, 0x3fff, 'cachedCavWord');
  integer(processorSelector, 1, 5, 'processorSelector');
  const output = Buffer.from(compact);
  // MicroDM 0x23dd54..0x23dda4. fpaWord is the native synthesized value;
  // do not substitute the incoming zero, CAV, or a scene temperature.
  output.writeUInt16LE(fpaWord, 0);
  output.writeUInt16LE(1, 10);
  output.writeUInt16LE(192, 16);
  output.writeUInt16LE(256, 18);
  output.writeUInt16LE(processorSelector - 1, 26);
  output.writeUInt16LE(cachedCavWord, 40);
  return output;
}

function applyResolvedHostValidity(compact, aggregateFlag, secondaryFlag = aggregateFlag) {
  checkCompact(compact);
  integer(aggregateFlag, 0, 1, 'aggregateFlag');
  integer(secondaryFlag, 0, 1, 'secondaryFlag');
  const output = Buffer.from(compact);
  // MicroDM 0x241e2c writes aggregate w25; 0x241e44 writes separate w24.
  // Both are zero on eligible frames. The default marks both invalid as an
  // application safeguard; it does not reproduce every native invalid state.
  output.writeUInt16LE(aggregateFlag, 12);
  output.writeUInt32LE(secondaryFlag, ROW_BYTES + 28);
  return output;
}

module.exports = {
  FRAME_BYTES, ROW_BYTES, COMPACT_BYTES, SENSOR_ID,
  sceneAccuracyValidated: false,
  extractCompactAdditional, rewriteSk02HostHeader, applyResolvedHostValidity,
};
