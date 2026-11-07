'use strict';
const { createHash } = require('node:crypto');
const { prepareRadiometry, grayToBlackbody } = require('./radiometry-state.cjs');
const { prepareEnvironment, blackbodyToObject, normalizeSdkEnvironment } = require('./radiometry-environment.cjs');
const { prepareGeneratedRadiometry } = require('./radiometry-inter.cjs');
const { estimateInitialReflection } = require('./reflected-temperature.cjs');
const GENERATED_ALGORITHM = 'sk02-float-online-port-v3-generated-reference';
const ALGORITHM = 'sk02-float-online-port-v2';
const WIDTH = 256, HEIGHT = 192, PIXELS = WIDTH * HEIGHT;
function grayToObject(gray, state, atmosphere) {
  const bb = grayToBlackbody(gray, state);
  if (bb.celsius === null) return bb;
  const point = blackbodyToObject(bb.celsius, atmosphere);
  return point.status !== 0 ? point : { ...point, status: bb.status };
}

function createRadiometry(calibrationBytes, { serial, environment = {}, generatedReference = false, automaticReflectedC = null } = {}) {
  if (typeof serial !== 'string' || !serial.trim() || /[\x00-\x1f]/.test(serial)) throw new Error('Verified camera serial is required');
  if (!Buffer.isBuffer(calibrationBytes) || calibrationBytes.length !== 14336) throw new Error('Expected device thermometry calibration');
  if (typeof generatedReference !== 'boolean') throw new Error('generatedReference must be an explicit boolean');
  const algorithm = generatedReference ? GENERATED_ALGORITHM : ALGORITHM;
  const calibration = Buffer.from(calibrationBytes);
  const calibrationSha256 = createHash('sha256').update(calibration).digest('hex');
  const settings = Object.freeze({ ambientC: 20, reflectedC: 20, humidityPercent: 60, distanceMeters: 1, emissivity: .97, ...environment });
  const encodedSettings = normalizeSdkEnvironment(settings);
  // Omitted mode preserves explicit historical/offline caller behavior. App
  // preferences always supply false (automatic) or true (manual).
  if (settings.reflectedManualOverride !== undefined && typeof settings.reflectedManualOverride !== 'boolean') throw new Error('Reflection override must be boolean');
  if (automaticReflectedC !== null && (!Number.isFinite(automaticReflectedC) || automaticReflectedC <= -273.15 || automaticReflectedC > 1000)) throw new Error('Invalid automatic reflection');
  let automatic = automaticReflectedC;
  const isAutomatic = settings.reflectedManualOverride === false;
  function observeSensor(sensorWord) {
    if (automatic === null) automatic = estimateInitialReflection(calibration, sensorWord);
    return automatic;
  }
  const effectiveEnvironment = () => isAutomatic ? Object.freeze({ ...settings, reflectedC: automatic }) : settings;
  let previousKey, values, statuses;
  function evaluate(corrected, metadata) {
    const provenance = { serial, algorithm, calibrationSha256, environment: effectiveEnvironment(),
      configuredEnvironment: settings, reflectedTemperatureSource: isAutomatic ? 'camera-initial-estimate' : 'manual', absoluteAccuracyValidated: false,
      ...(generatedReference ? { experimental: true, generatedReference: true } : {}) };
    try {
      if (!(corrected instanceof Uint16Array) || corrected.length !== PIXELS) throw new Error('Expected a corrected 256 by 192 detector plane');
      const state = (generatedReference ? prepareGeneratedRadiometry : prepareRadiometry)(calibration, metadata, encodedSettings);
      if (isAutomatic && automatic === null) observeSensor(metadata.readUInt16LE(2));
      if (isAutomatic && automatic === null) throw new Error('Waiting for automatic reflected temperature');
      provenance.environment = effectiveEnvironment();
      if (generatedReference) provenance.generatedReferenceDetails = state.generatedReference;
      const atmosphere = prepareEnvironment(calibration, { ...encodedSettings, ...(isAutomatic ? { reflectedC: automatic } : {}), range: state.range, lens: state.lens });
      if (atmosphere.status !== 0) throw new Error(`Atmospheric conversion failed (${atmosphere.status})`);
      const key = JSON.stringify([state, atmosphere]);
      if (key !== previousKey) {
        previousKey = key;
        values = new Float32Array(16384);
        statuses = new Int16Array(16384); statuses.fill(32767);
      }
      let high = -Infinity, low = Infinity, highIndex = 0, lowIndex = 0, invalidPixels = 0, center;
      const centerIndex = Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2);
      for (let i = 0; i < PIXELS; i++) {
        const gray = corrected[i];
        if (gray > 16383) { invalidPixels++; continue; }
        if (statuses[gray] === 32767) {
          const point = grayToObject(gray, state, atmosphere);
          statuses[gray] = point.status;
          if (point.status === 0) values[gray] = point.celsius;
        }
        if (statuses[gray] !== 0 || !Number.isFinite(values[gray])) { invalidPixels++; continue; }
        const value = values[gray];
        if (value > high) { high = value; highIndex = i; }
        if (value < low) { low = value; lowIndex = i; }
        if (i === centerIndex) center = value;
      }
      // Whole-image extrema must not hide invalid or out-of-range pixels.
      if (invalidPixels || !Number.isFinite(center)) return { temperatures: null, calibration: { ...provenance,
        status: 'out-of-range', reason: `${invalidPixels} detector pixels have no valid temperature`, invalidPixels } };
      return { temperatures: { center, high, low, highX: highIndex % WIDTH, highY: Math.floor(highIndex / WIDTH),
        lowX: lowIndex % WIDTH, lowY: Math.floor(lowIndex / WIDTH) },
      calibration: { ...provenance, status: 'factory-calibrated', range: state.range, gear: state.gear } };
    } catch (error) {
      return { temperatures: null, calibration: { ...provenance, status: 'unavailable', reason: error.message } };
    }
  }
  return Object.freeze({ evaluate, observeSensor, serial, algorithm, calibrationSha256, configuredEnvironment: settings,
    get automaticReflectedC() { return automatic; }, get environment() { return effectiveEnvironment(); } });
}
module.exports = { createRadiometry, grayToObject, ALGORITHM, GENERATED_ALGORITHM };
