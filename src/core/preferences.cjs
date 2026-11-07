'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const MAX_BYTES = 1024;
const EMISSIVITY_PRESETS = Object.freeze({'ice-water':.95,pcb:.91,concrete:.95,ceramics:.92,paint:.93,wood:.85,asphalt:.96,brick:.95,sand:.90,soil:.92,cotton:.98,cardboard:.90,'white-paper':.90,water:.96});
const DEFAULT_MEASUREMENT_ENVIRONMENT = Object.freeze({ emissivityPreset: 'custom', emissivity: .91, distanceMeters: .9144, ambientC: 20, reflectedC: 20, reflectedManualOverride: false, humidityPercent: 60 });
function validateMeasurementEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RangeError('Measurement parameters must be an object.');
  const result = {};
  for (const [key, low, high, label] of [
    ['emissivity', .01, 1, 'Emissivity'], ['distanceMeters', .1, 100, 'Distance in meters'],
    ['ambientC', -40, 100, 'Air temperature in Celsius'], ['reflectedC', -40, 100, 'Reflected temperature in Celsius'],
    ['humidityPercent', 0, 100, 'Relative humidity']
  ]) {
    if (!Number.isFinite(value[key]) || value[key] < low || value[key] > high) throw new RangeError(label + ' must be between ' + low + ' and ' + high + '.');
    result[key] = value[key];
  }
  const preset=value.emissivityPreset===undefined?'custom':value.emissivityPreset;
  if(typeof preset!=='string'||(preset!=='custom'&&!Object.hasOwn(EMISSIVITY_PRESETS,preset)))throw new RangeError('Unknown emissivity material preset.');
  if(preset!=='custom'&&result.emissivity!==EMISSIVITY_PRESETS[preset])throw new RangeError('Emissivity does not match the selected material preset.');
  result.emissivityPreset=preset;
  // Existing preferences adopt automatic reflection; retain their saved manual
  // value so explicitly enabling the override restores it.
  const override=value.reflectedManualOverride===undefined?false:value.reflectedManualOverride;
  if(typeof override!=='boolean')throw new RangeError('Reflected temperature manual override must be boolean.');
  result.reflectedManualOverride=override;
  return result;
}
function defaults() { return { temperatureUnit: 'C', previewResolution: 'enhanced', measurementEnvironment: { ...DEFAULT_MEASUREMENT_ENVIRONMENT } }; }
function validated(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['C','F'].includes(value.temperatureUnit)) throw new RangeError('Temperature unit must be C or F.');
  const previewResolution=value.previewResolution===undefined?'enhanced':value.previewResolution;
  if(!['native','enhanced'].includes(previewResolution))throw new RangeError('Unknown preview resolution.');
  return { temperatureUnit: value.temperatureUnit, previewResolution, measurementEnvironment: value.measurementEnvironment === undefined
    ? { ...DEFAULT_MEASUREMENT_ENVIRONMENT } : validateMeasurementEnvironment(value.measurementEnvironment) };
}
function loadPreferences(filename) {
  let fd;
  try {
    const entry = fs.lstatSync(filename);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_BYTES) return defaults();
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_BYTES) return defaults();
    // Read one extra byte to reject a file that grows after the stat, without
    // ever allocating or parsing an unbounded settings file.
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (!n) break;
      count += n;
    }
    if (count > MAX_BYTES) return defaults();
    return validated(JSON.parse(bytes.subarray(0, count).toString('utf8'))) || defaults();
  } catch { return defaults(); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Loading preferences must safely default even on I/O failure. */ } } }
}
function savePreferences(filename, preferences) {
  const value = validated(preferences);
  if (!value) throw new RangeError('Temperature unit must be C or F.');
  const parent = path.dirname(filename);
  fs.mkdirSync(parent, { recursive: true });
  try {
    const entry = fs.lstatSync(filename);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Preferences destination must be a regular file.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(parent, `.${path.basename(filename)}.${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    const data = Buffer.from(JSON.stringify(value) + '\n');
    let written = 0;
    while (written < data.length) {
      const n = fs.writeSync(fd, data, written, data.length - written, written);
      if (n <= 0) throw new Error('Writing preferences made no progress.');
      written += n;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, filename);
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); }
    finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  return value;
}
module.exports = { loadPreferences, savePreferences, validateMeasurementEnvironment, DEFAULT_MEASUREMENT_ENVIRONMENT, EMISSIVITY_PRESETS };
