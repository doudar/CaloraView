'use strict';

const { PROFILE } = require('./thermal.cjs');

// APK F2 additional-data origin: MicroDM 0x25f6b0. CAV is word 1,
// loaded by 0x24ba78 and passed to IFR_NUC_Process realtime +0xa4.
// This is an internal sensor signal for drift, never a scene temperature.
const ADDITIONAL_OFFSET = 216 * PROFILE.width * 2;
const CAV_OFFSET = ADDITIONAL_OFFSET + 2;
const SENSOR_SCALE = 50;

function decodeSensorWord(word) {
  if (!Number.isInteger(word) || word < 0 || word > 0x3fff) {
    throw new RangeError('Sensor word must be a 14-bit unsigned integer');
  }
  // IFR_NUC_Process 0x1d620: this is not two's-complement int16.
  return word >= 0x2000 ? 0x2000 - word : word;
}

function readFrameMetadata(frame) {
  if (!Buffer.isBuffer(frame) || frame.length !== PROFILE.frameBytes) {
    throw new RangeError(`Expected one ${PROFILE.frameBytes}-byte SK02 frame`);
  }
  const sensorRaw = frame.readUInt16LE(CAV_OFFSET);
  // The SDK retains the previous nonzero CAV when the incoming value is zero.
  // This stateless parser reports missing/unsupported data instead of silently
  // inheriting another frame's signal or applying a guessed flags mask.
  const valid = sensorRaw !== 0 && sensorRaw <= 0x3fff;
  const sensorCounts = valid ? decodeSensorWord(sensorRaw) : null;
  return {
    source: 'f2-additional-cav-word1',
    sensorRaw,
    sensorCounts,
    sensorUnits: valid ? sensorCounts / SENSOR_SCALE : null,
    valid,
  };
}

module.exports = { ADDITIONAL_OFFSET, CAV_OFFSET, SENSOR_SCALE, decodeSensorWord, readFrameMetadata };
