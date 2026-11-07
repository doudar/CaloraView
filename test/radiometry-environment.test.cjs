'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {prepareEnvironment,blackbodyToObject,calcTransmission}=require('../src/core/radiometry-environment.cjs');
const vectors=require('./fixtures/environment-synthetic.json');
function synthetic(){const b=Buffer.alloc(14336);b.writeUInt32LE(0x404);b.writeUInt32LE(14336,4);b.writeUInt32LE(83,8);[[1,1,0],[.5,20,2],[2,100,-3]].forEach((a,i)=>a.forEach((x,j)=>b.writeFloatLE(x,0x21ac+i*32+j*4)));return b;}
test('environment and object conversion match synthetic native float vectors in all three ranges',()=>{
 const cal=synthetic(),before=Buffer.from(cal);
 for(const v of vectors){const e=prepareEnvironment(cal,v.environment);assert.equal(e.status,v.transmissionStatus);assert.equal(e.tau,v.tau);const result=blackbodyToObject(v.blackbodyC,e);assert.equal(result.status,v.status??v.transmissionStatus);assert.equal(result.celsius,v.celsius??null);}
 assert.deepEqual(cal,before);
});
test('environment rejects unsupported coefficients, ranges and malformed inputs',()=>{
 for(const options of [{lens:1},{range:3},{emissivity:0},{emissivity:1.1},{distanceMeters:0},{humidityPercent:101},{ambientC:NaN},{ambientC:-273.15},{reflectedC:Infinity},{distanceMeters:1e300}])assert.throws(()=>prepareEnvironment(synthetic(),options));
 assert.throws(()=>prepareEnvironment(Buffer.alloc(10)));
 let c=synthetic();c.writeFloatLE(1,0x3784);c.writeFloatLE(1,0x3788);assert.throws(()=>prepareEnvironment(c),/spectral/);
 c=synthetic();c.writeFloatLE(1,0x3680);c.writeFloatLE(1,0x3684);assert.throws(()=>prepareEnvironment(c),/polynomial/);
 c=synthetic();c.writeFloatLE(NaN,0x21ac);assert.throws(()=>prepareEnvironment(c),/Non-finite/);
});
test('reference emissivity and transparent air recover blackbody temperature',()=>{
 const e={status:0,tau:1,emissivity:Math.fround(.97),ambientC:20,reflectedC:20};
 for(const c of [-20,20,60,150])assert.ok(Math.abs(blackbodyToObject(c,e).celsius-c)<.0001);
 assert.deepEqual(blackbodyToObject(NaN,e),{status:-19,celsius:null});
 assert.deepEqual(blackbodyToObject(20,{...e,status:-305,tau:null}),{status:-305,celsius:null});
 assert.deepEqual(blackbodyToObject(20,{...e,emissivity:0}),{status:-19,celsius:null});
});
test('atmosphere fails closed after attenuation underflow',()=>{
 assert.deepEqual(calcTransmission({ambientC:100,humidityFraction:1,distanceMeters:100},[1,1100,0]),{status:-305,tau:null});
});
test('SDK environment normalization preserves setter and point float rounding',()=>{
 const {normalizeSdkEnvironment}=require('../src/core/radiometry-environment.cjs');
 const e=normalizeSdkEnvironment({ambientC:30,humidityPercent:60,distanceMeters:1});
 assert.equal(e.ambientC,30.000001907348633);assert.equal(e.humidityPercent,60.000003814697266);assert.equal(e.distanceMeters,Math.fround(.001));
 assert.equal(normalizeSdkEnvironment({ambientC:20.0006}).ambientC,Math.fround(Math.fround(20001)*Math.fround(.001)));
 assert.throws(()=>normalizeSdkEnvironment({ambientC:1e20}));
});
test('SDK100% humidity uses the native exact-one special case',()=>{
 const {normalizeSdkEnvironment}=require('../src/core/radiometry-environment.cjs');
 const options=normalizeSdkEnvironment({humidityPercent:100,emissivity:.01});
 assert.equal(options.humidityPercent,100);assert.doesNotThrow(()=>prepareEnvironment(synthetic(),options));
});


test('SDK distance follows UI metres through Q13 and native point scaling without an extra1000',()=>{
 const {encodeSdkDistance,normalizeSdkEnvironment}=require('../src/core/radiometry-environment.cjs');
 assert.deepEqual(encodeSdkDistance(1),{q13:8192,pointDistance:1,atmosphericDistance:Math.fround(.001)});
 const x=encodeSdkDistance(.9);assert.equal(x.q13,7372);assert.equal(x.pointDistance,.89990234375);
 assert.equal(x.atmosphericDistance,Math.fround(.89990234375*Math.fround(.001)));
 const cal=synthetic();cal.writeFloatLE(1000,0x21b0);cal.writeFloatLE(.6,0x21b4);
 const corrected=prepareEnvironment(cal,normalizeSdkEnvironment({distanceMeters:1}));
 assert.ok(corrected.tau>.95);assert.ok(prepareEnvironment(cal,{distanceMeters:1}).tau<.5);
 for(const value of [0,-1,NaN,Infinity,1e10,1e-10])assert.throws(()=>encodeSdkDistance(value));
});
