'use strict';
const { decodeSensorWord } = require('./frame-metadata.cjs');
const f = Math.fround;

// Fresh producer: predicted ambient = calibrated CAV (rise starts at zero).
// MicroRVP 170b60/171dc4/1722e8 transports milli-Celsius, then initializes
// an unset reflection in Q13. The caller retains this value for the connection.
// This is an estimate, not a measurement of reflected scene radiation.
function encodeInitialReflection(predictedAmbientC) {
  if (!Number.isFinite(predictedAmbientC) || predictedAmbientC <= -273.15 || predictedAmbientC > 1000) throw new RangeError('Invalid reflected-temperature estimate');
  const milli = Math.trunc(f(f(predictedAmbientC) * 1000));
  const parsed = f(f(milli) / 1000);
  return f(Math.trunc(parsed * 8192) / 8192);
}

function estimateInitialReflection(calibration, sensorWord) {
  if (!Number.isInteger(sensorWord) || sensorWord <= 0 || sensorWord > 0x3fff) return null;
  if (!Buffer.isBuffer(calibration) || calibration.length !== 14336
      || calibration.readUInt32LE(0) !== 0x404 || calibration.readUInt32LE(8) !== 83
      || calibration.readInt32LE(0x2b10) !== 0) throw new Error('Unsupported reflection calibration');
  const scale = calibration.readFloatLE(0x27ec), offset = calibration.readFloatLE(0x27f0);
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(offset)) throw new Error('Invalid reflection sensor calibration');
  return encodeInitialReflection(f(f(decodeSensorWord(sensorWord) * scale) + offset));
}

module.exports = { encodeInitialReflection, estimateInitialReflection };
