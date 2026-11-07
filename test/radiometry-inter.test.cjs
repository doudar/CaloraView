'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateInter, prepareGeneratedRadiometry } = require('../src/core/radiometry-inter.cjs');
const { prepareRadiometry } = require('../src/core/radiometry-state.cjs');
const { createRadiometry, ALGORITHM, GENERATED_ALGORITHM } = require('../src/core/radiometry.cjs');

// Invented coefficients; no vendor calibration or camera media is embedded.
function fixture() {
  const calibration = Buffer.alloc(14336), metadata = Buffer.alloc(1024);
  calibration.writeUInt32LE(0x404, 0); calibration.writeUInt32LE(83, 8);
  calibration.write('HM-TJ12-3AAY1F', 16, 'ascii');
  const set = (offset, value) => calibration.writeFloatLE(value, offset);
  set(0x27f4, 1); set(0x27ec, .02); set(0x50, -100); set(0x64, 500);
  set(0x270, 25); set(0x464, 20); set(0xd20, 1);
  set(0x698, 100000); set(0x69c, 1400); set(0x6a4, 1);
  set(0x28a8, -100); set(0x2898, 100);
  set(0x1eac, 1); set(0x1eb0, 5); set(0x1eb4, 2); set(0x1eb8, 3);
  set(0x21ac, 1); set(0x21b0, 1100); set(0x21b4, .6);
  metadata.writeUInt16LE(1250, 2); metadata.writeUInt16LE(1, 10);
  metadata.writeUInt16LE(192, 16); metadata.writeUInt16LE(256, 18);
  return { calibration, metadata, set };
}

test('generated reference uses device reference and live CAV without mutating inputs', () => {
  const { calibration, metadata } = fixture();
  const originalCal = Buffer.from(calibration), originalMeta = Buffer.from(metadata);
  const baseline = generateInter(calibration, metadata);
  assert.equal(baseline.currentCavGray, 0);
  assert.equal(baseline.inter[0], baseline.state.referenceGray);
  assert.notEqual(baseline.inter[0], 8192);
  assert.deepEqual(baseline.inter.slice(1), [10000000, 0, 0]);
  assert.deepEqual(calibration, originalCal); assert.deepEqual(metadata, originalMeta);
  const warmer = Buffer.from(metadata); warmer.writeUInt16LE(1500, 2);
  assert.ok(generateInter(calibration, warmer).inter[0] < baseline.inter[0]);
});

test('manual ambient drift applies once in consumer and does not change generated inter', () => {
  const { calibration, metadata } = fixture();
  const values = [15, 20, 25].map(ambientC => ({
    original: prepareRadiometry(calibration, metadata, { ambientC }),
    generated: prepareGeneratedRadiometry(calibration, metadata, { ambientC }),
  }));
  assert.equal(new Set(values.map(x => x.generated.generatedReference.interGray)).size, 1);
  for (const { original, generated } of values) {
    assert.equal(generated.baseGray - generated.generatedReference.interGray, original.baseGray - 8192);
    assert.equal(generated.linear, original.linear);
    assert.equal(generated.quadratic, original.quadratic);
    assert.equal(generated.generatedReference.experimental, true);
  }
  assert.equal(values[0].generated.baseGray - values[1].generated.baseGray, -15);
  assert.equal(values[2].generated.baseGray - values[1].generated.baseGray, 10);
});

test('unsupported secondary corrections and ineligible frames fail closed', () => {
  for (const offset of [0x1ec0, 0x1ec4, 0x1ec8, 0xd24]) {
    const { calibration, metadata, set } = fixture(); set(offset, 1);
    assert.throws(() => prepareGeneratedRadiometry(calibration, metadata), /Unsupported/);
  }
  const { calibration, metadata, set } = fixture(); set(0x1eac, NaN);
  assert.throws(() => prepareGeneratedRadiometry(calibration, metadata), /Non-finite/);
  const busy = Buffer.from(metadata); busy.writeUInt16LE(1, 12);
  assert.throws(() => prepareGeneratedRadiometry(fixture().calibration, busy), /eligible/);
});

test('generated-reference option is explicitly experimental and defaults remain v2', () => {
  const { calibration, metadata } = fixture();
  const defaultProcessor = createRadiometry(calibration, { serial: 'synthetic' });
  const disabled = createRadiometry(calibration, { serial: 'synthetic', generatedReference: false });
  const experimental = createRadiometry(calibration, { serial: 'synthetic', generatedReference: true });
  const plane = new Uint16Array(49152).fill(8192), original = plane.slice();
  const a = defaultProcessor.evaluate(plane, metadata), b = disabled.evaluate(plane, metadata);
  assert.deepEqual(a, b); assert.equal(a.calibration.algorithm, ALGORITHM);
  assert.equal('experimental' in a.calibration, false);
  const enabled = experimental.evaluate(plane, metadata);
  assert.equal(experimental.algorithm, GENERATED_ALGORITHM);
  assert.equal(enabled.calibration.algorithm, GENERATED_ALGORITHM);
  assert.equal(enabled.calibration.status, 'factory-calibrated');
  assert.ok(Number.isFinite(enabled.temperatures.center));
  assert.equal(enabled.calibration.experimental, true);
  assert.equal(enabled.calibration.generatedReference, true);
  assert.equal(enabled.calibration.absoluteAccuracyValidated, false);
  assert.ok(enabled.calibration.generatedReferenceDetails);
  assert.notDeepEqual(enabled.temperatures, a.temperatures);
  assert.deepEqual(plane, original);
  assert.throws(() => createRadiometry(calibration, { serial: 'synthetic', generatedReference: 'false' }), /boolean/);
  const busy = Buffer.from(metadata); busy.writeUInt16LE(1, 12);
  const unavailable = experimental.evaluate(plane, busy);
  assert.equal(unavailable.temperatures, null);
  assert.equal(unavailable.calibration.experimental, true);
  assert.deepEqual(experimental.evaluate(plane, metadata), enabled);
});

test('automatic reflection uses first sensor sample, survives setting changes and resets on reconnect', () => {
  const {calibration,metadata}=fixture(),plane=new Uint16Array(49152).fill(8192);
  const environment={reflectedManualOverride:false,reflectedC:90,ambientC:20,emissivity:.85};
  const make=(environment,automaticReflectedC=null)=>createRadiometry(calibration,{serial:'synthetic',generatedReference:true,environment,automaticReflectedC});
  const automatic=make(environment);
  assert.equal(automatic.environment.reflectedC,null);
  assert.equal(automatic.observeSensor(0),null);
  assert.equal(automatic.observeSensor(0x4000),null);
  assert.equal(automatic.observeSensor(1250),25);
  assert.equal(automatic.observeSensor(1500),25);
  const result=automatic.evaluate(plane,metadata);
  assert.equal(result.calibration.environment.reflectedC,25);
  assert.equal(result.calibration.configuredEnvironment.reflectedC,90);
  assert.equal(result.calibration.reflectedTemperatureSource,'camera-initial-estimate');
  const manual=make({...environment,reflectedManualOverride:true,reflectedC:25},automatic.automaticReflectedC);
  assert.deepEqual(result.temperatures,manual.evaluate(plane,metadata).temperatures);
  const colder=make({...environment,reflectedManualOverride:true,reflectedC:20},automatic.automaticReflectedC);
  assert.ok(colder.evaluate(plane,metadata).temperatures.center>result.temperatures.center);
  const restored=make({...environment,humidityPercent:45},manual.automaticReflectedC);
  restored.observeSensor(1500);
  assert.equal(restored.environment.reflectedC,25);
  assert.equal(make(environment).observeSensor(1500),30);
});

test('invalid measurement metadata cannot initialize automatic reflection through evaluate', () => {
  const {calibration,metadata}=fixture(),plane=new Uint16Array(49152).fill(8192);
  const automatic=createRadiometry(calibration,{serial:'synthetic',generatedReference:true,environment:{reflectedManualOverride:false}});
  const busy=Buffer.from(metadata);busy.writeUInt16LE(1,12);
  assert.equal(automatic.evaluate(plane,busy).temperatures,null);
  assert.equal(automatic.automaticReflectedC,null);
  const result=automatic.evaluate(plane,metadata);
  assert.equal(result.calibration.environment.reflectedC,25);
  assert.ok(result.temperatures);
});
