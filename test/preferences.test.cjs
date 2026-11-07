'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { loadPreferences, savePreferences, validateMeasurementEnvironment, DEFAULT_MEASUREMENT_ENVIRONMENT } = require('../src/core/preferences.cjs');
const expected = temperatureUnit => ({temperatureUnit,previewResolution:'enhanced',measurementEnvironment:{...DEFAULT_MEASUREMENT_ENVIRONMENT}});
function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caloraview-preferences-'));
  t.after(() => { for (const name of fs.readdirSync(folder)) fs.unlinkSync(path.join(folder, name)); fs.rmdirSync(folder); });
  return { folder, file:path.join(folder, 'preferences.json') };
}
test('temperature choice persists across module reload and only known settings are saved', t => {
  const { file } = fixture(t);
  assert.deepEqual(loadPreferences(file), expected('C'));
  assert.deepEqual(savePreferences(file, { temperatureUnit:'F',unrelated:'discard me' }), expected('F'));
  delete require.cache[require.resolve('../src/core/preferences.cjs')];
  assert.deepEqual(require('../src/core/preferences.cjs').loadPreferences(file), expected('F'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), expected('F'));
  savePreferences(file, expected('C'));
  assert.deepEqual(loadPreferences(file), expected('C'));
});
test('missing, malformed, oversized and unsupported settings safely default to Celsius', t => {
  const { file } = fixture(t);
  for (const text of ['', '{', 'null', '[]', '3', '{"temperatureUnit":"K"}', '{"temperatureUnit":false}', ' '.repeat(1025)]) {
    fs.writeFileSync(file, text);
    assert.deepEqual(loadPreferences(file), expected('C'));
  }
  fs.writeFileSync(file, '{"temperatureUnit":"F","unknown":123}');
  assert.deepEqual(loadPreferences(file), expected('F'));
  assert.deepEqual(loadPreferences(path.dirname(file)), expected('C'));
});
test('failed atomic replacement retains previous choice and removes temporary file', t => {
  const { file, folder } = fixture(t);
  savePreferences(file, expected('F'));
  const before = fs.readFileSync(file);
  const mock = t.mock.method(fs, 'renameSync', () => { throw new Error('Simulated rename failure'); });
  assert.throws(() => savePreferences(file, { temperatureUnit:'C' }), /rename failure/);
  mock.mock.restore();
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(folder), ['preferences.json']);
});
test('invalid saves cannot overwrite valid settings or write through nonregular targets', t => {
  const { file, folder } = fixture(t);
  savePreferences(file, expected('F'));
  for (const value of [null,[],{}, { temperatureUnit:'fahrenheit' }]) assert.throws(() => savePreferences(file, value), /C or F/);
  assert.deepEqual(loadPreferences(file), expected('F'));
  assert.throws(() => savePreferences(folder, { temperatureUnit:'C' }), /regular file/);
});
test('partial writes finish correctly and zero-progress failures retain original settings', t => {
  const { file, folder } = fixture(t), original = fs.writeSync;
  savePreferences(file, expected('C'));
  const partial = t.mock.method(fs, 'writeSync', function (fd, data, offset, length, position) {
    return original.call(this, fd, data, offset, Math.min(3, length), position);
  });
  savePreferences(file, expected('F')); partial.mock.restore();
  assert.deepEqual(loadPreferences(file), expected('F'));
  const blocked = t.mock.method(fs, 'writeSync', () => 0);
  assert.throws(() => savePreferences(file, { temperatureUnit:'C' }), /no progress/); blocked.mock.restore();
  assert.deepEqual(loadPreferences(file), expected('F'));
  assert.deepEqual(fs.readdirSync(folder), ['preferences.json']);
});


test('measurement parameters persist and legacy unit-only preferences gain defaults', t => {
  const {file}=fixture(t); fs.writeFileSync(file, '{"temperatureUnit":"F"}');
  assert.deepEqual(loadPreferences(file), expected('F'));
  const environment = {reflectedManualOverride:true,emissivityPreset:'concrete',emissivity:.95,distanceMeters:3.048,ambientC:25,reflectedC:18,humidityPercent:45};
  const saved = savePreferences(file,{temperatureUnit:'F',measurementEnvironment:{...environment,extra:'discard'}});
  assert.deepEqual(saved.measurementEnvironment,environment); assert.deepEqual(loadPreferences(file),saved);
  savePreferences(file,{...saved,temperatureUnit:'C'});
  assert.deepEqual(loadPreferences(file).measurementEnvironment,environment);
  savePreferences(file,{temperatureUnit:'C'}); assert.deepEqual(loadPreferences(file),expected('C'));
});

test('invalid or incomplete environment never overwrites preferences; bounds are inclusive', t => {
  const {file}=fixture(t); savePreferences(file,expected('F')); const before=fs.readFileSync(file);
  for(const [key, values] of Object.entries({emissivity:[0,1.1,NaN],distanceMeters:[0,101,Infinity],ambientC:[-41,101,'20'],reflectedC:[-41,101,null],humidityPercent:[-1,101,undefined]})) {
    for(const value of values) assert.throws(()=>savePreferences(file,{temperatureUnit:'F',measurementEnvironment:{...DEFAULT_MEASUREMENT_ENVIRONMENT,[key]:value}}),/must be between/);
  }
  for(const value of [null,[],{}, {emissivity:.91}]) assert.throws(()=>validateMeasurementEnvironment(value),/must be/);
  assert.deepEqual(fs.readFileSync(file),before);
  const limits={reflectedManualOverride:false,emissivityPreset:'custom',emissivity:.01,distanceMeters:100,ambientC:-40,reflectedC:100,humidityPercent:0};
  assert.deepEqual(validateMeasurementEnvironment(limits),limits);
  fs.writeFileSync(file,JSON.stringify({temperatureUnit:'F',measurementEnvironment:{...limits,humidityPercent:101}}));
  assert.deepEqual(loadPreferences(file),expected('C'));
});


test('material presets persist only known identifiers paired with their stated emissivity', t => {
  const {file}=fixture(t);
  const environment={...DEFAULT_MEASUREMENT_ENVIRONMENT,emissivity:.95,emissivityPreset:'ice-water'};
  savePreferences(file,{temperatureUnit:'C',measurementEnvironment:environment});
  assert.deepEqual(loadPreferences(file).measurementEnvironment,environment);
  assert.throws(()=>validateMeasurementEnvironment({...environment,emissivityPreset:'unknown'}),/Unknown/);
  assert.throws(()=>validateMeasurementEnvironment({...environment,emissivity:.91}),/does not match/);
  const legacy={...DEFAULT_MEASUREMENT_ENVIRONMENT};delete legacy.emissivityPreset;
  assert.equal(validateMeasurementEnvironment(legacy).emissivityPreset,'custom');
});

test('legacy reflection becomes automatic without losing the saved manual value', t => {
  const {file}=fixture(t);
  const legacy={...DEFAULT_MEASUREMENT_ENVIRONMENT,reflectedC:32.22222222222222};
  delete legacy.reflectedManualOverride;
  fs.writeFileSync(file,JSON.stringify({temperatureUnit:'F',measurementEnvironment:legacy}));
  const migrated=loadPreferences(file);
  assert.equal(migrated.measurementEnvironment.reflectedManualOverride,false);
  assert.equal(migrated.measurementEnvironment.reflectedC,legacy.reflectedC);
  savePreferences(file,{...migrated,measurementEnvironment:{...migrated.measurementEnvironment,reflectedManualOverride:true}});
  assert.equal(loadPreferences(file).measurementEnvironment.reflectedManualOverride,true);
  for(const value of ['false',0,1,null])assert.throws(()=>validateMeasurementEnvironment({...legacy,reflectedManualOverride:value}),/boolean/);
});

test('HD is the default for new and legacy preferences and either preview mode persists', t => {
  const {file}=fixture(t);
  assert.equal(loadPreferences(file).previewResolution,'enhanced');
  fs.writeFileSync(file,JSON.stringify({temperatureUnit:'F',measurementEnvironment:DEFAULT_MEASUREMENT_ENVIRONMENT}));
  assert.equal(loadPreferences(file).previewResolution,'enhanced');
  for(const previewResolution of ['native','enhanced']){
    const saved=savePreferences(file,{...loadPreferences(file),previewResolution});
    assert.equal(loadPreferences(file).previewResolution,previewResolution);
    assert.equal(loadPreferences(file).temperatureUnit,'F');
    const before=fs.readFileSync(file);
    for(const invalid of ['',null,false,'HD'])assert.throws(()=>savePreferences(file,{...saved,previewResolution:invalid}),/preview resolution/);
    assert.deepEqual(fs.readFileSync(file),before);
  }
});
