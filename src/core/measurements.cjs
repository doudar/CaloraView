'use strict';
const { PROFILE } = require('./thermal.cjs');

// All consumers use the same gate. A downloaded table or a visual flat field
// alone must never turn a numeric object into a temperature measurement.
function validatedTemperatures(frame) {
  const t = frame.temperatures, calibration = frame.calibration;
  if (calibration?.status !== 'factory-calibrated' || !calibration.serial || !calibration.algorithm || !t) return null;
  if (!['center', 'high', 'low'].every(key => Number.isFinite(t[key]))) return null;
  if (t.low > t.center || t.center > t.high) return null;
  for (const key of ['highX', 'lowX']) if (!Number.isInteger(t[key]) || t[key] < 0 || t[key] >= PROFILE.imageWidth) return null;
  for (const key of ['highY', 'lowY']) if (!Number.isInteger(t[key]) || t[key] < 0 || t[key] >= PROFILE.imageHeight) return null;
  return t;
}
module.exports = { validatedTemperatures };
