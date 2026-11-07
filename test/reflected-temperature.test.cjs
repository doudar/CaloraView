'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {encodeInitialReflection,estimateInitialReflection}=require('../src/core/reflected-temperature.cjs');

test('automatic reflection matches the native milli-Celsius and Q13 bridge',()=>{
  // Synthetic inputs executed through MicroRVP 170b60,171dc4,1722e8.
  for(const [input,expected] of [[-40.125,-40.125],[-1.001,-1.0009765625],[.001,.0009765625],
    [20,20],[25,25],[31.84,31.8399658203125],[31.859999,31.85888671875],[40.5,40.5]]) {
    assert.equal(encodeInitialReflection(input),expected);
  }
  for(const value of [NaN,Infinity,-273.15,1001])assert.throws(()=>encodeInitialReflection(value),/Invalid/);
});

test('automatic reflection needs valid sensor words and supported calibration',()=>{
  const calibration=Buffer.alloc(14336);
  assert.equal(estimateInitialReflection(calibration,0),null);
  assert.throws(()=>estimateInitialReflection(calibration,1500),/Unsupported/);
  calibration.writeUInt32LE(0x404,0);calibration.writeUInt32LE(83,8);
  calibration.writeFloatLE(.02,0x27ec);calibration.writeFloatLE(1,0x27f0);
  assert.equal(estimateInitialReflection(calibration,1500),31);
  calibration.writeFloatLE(NaN,0x27ec);
  assert.throws(()=>estimateInitialReflection(calibration,1500),/Invalid/);
});
