'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {FactoryProcessor,extractPlane}=require('../src/core/factory-processor.cjs');
const {parseBadPixels,correctIsolatedBadPixels}=require('../src/core/bad-pixels.cjs');
function frame(value=8000,sensor=1500){const b=Buffer.alloc(117216);for(let i=0;i<b.length;i+=2)b.writeUInt16LE(value+((i/2)%2),i);b.writeUInt16LE(sensor,114050);b.writeUInt16LE(0,114062);return b;}
function processor(vc=null){const gain2=Buffer.alloc(98304);for(let i=0;i<gain2.length;i+=2)gain2.writeUInt16LE(32768,i);return new FactoryProcessor({gain2,badPixels:Buffer.alloc(0),vignettingCorrection:vc});}
test('reference cannot be fabricated from open frames or missing sensor values',()=>{const p=processor();assert.throws(()=>p.setShutterReference(Array.from({length:16},()=>frame())),/confirmed/);assert.throws(()=>p.setShutterReference(Array.from({length:16},()=>frame(8000,0)),{shutterClosed:true}),/CAV/);assert.equal(p.process(frame()).reason,'shutter-reference-required');});
test('startup pipeline preserves input, uses sixteen final closed frames and requires VC',()=>{const p=processor(),frames=[...Array.from({length:4},()=>frame(7000)),...Array.from({length:16},()=>frame())];const r=p.setShutterReference(frames,{shutterClosed:true});assert.equal(r.acceptedFrames,16);const scene=frame(8100),before=Buffer.from(scene);const out=p.process(scene);assert.equal(out.valid,false);assert.equal(out.reason,'vignetting-stage-required');assert.equal(out.corrected[0],8292);assert.equal(out.metadata.readUInt16LE(26),2);assert.equal(out.metadata.readUInt16LE(12),1);assert.deepEqual(scene,before);});
test('zero metadata and drift invalidate instead of emitting misleading temperatures',()=>{const p=processor(image=>image);p.setShutterReference(Array.from({length:16},()=>frame()),{shutterClosed:true});assert.equal(p.process(frame(8100,0)).reason,'missing-sensor-word');assert.equal(p.process(frame(8100,1513)).reason,'sensor-drift-needs-reference');assert.equal(p.process(frame(8100,1500),{shutterBusy:true}).reason,'shutter-active');assert.equal(p.process(frame(8100,1500)).valid,true);});
test('factory bad pixel coordinates and isolated boundaries',()=>{const b=Buffer.alloc(8);b.writeUInt32LE(0x10ab);b.writeUInt32LE(0x4e00e,4);const points=parseBadPixels(b);assert.deepEqual(points,[{x:170,y:0},{x:13,y:77}]);const a=new Uint16Array(49152).fill(8000);a[170]=1;a[77*256+13]=2;const out=correctIsolatedBadPixels(a,points);assert.equal(out[170],8000);assert.equal(out[77*256+13],8000);assert.equal(a[170],1);});
test('clustered bad-pixel maps fail explicitly',()=>{const b=Buffer.alloc(8);b.writeUInt32LE(0x1001);b.writeUInt32LE(0x1002,4);assert.throws(()=>parseBadPixels(b),/Clustered/);});


test('explicit eight-frame reference selects final8 and preserves native fourth-sample CAV anchor',()=>{
 const p=processor(image=>image);
 const sensors=[1502,1503,1500,1500,1500,1500,1500,1600];
 const frames=[...Array.from({length:4},()=>frame(7000)),...sensors.map(sensor=>frame(8000,sensor))];
 const r=p.setShutterReference(frames,{shutterClosed:true,referenceCount:8});
 assert.equal(r.acceptedFrames,8);assert.equal(r.offeredFrames,12);assert.equal(r.sensorBaseline,1500);
 assert.equal(r.eligibility,'app-confirmed-closed-window-last8');assert.equal(r.nativeControllerEquivalent,false);
 assert.equal(p.cachedCav,1600);
 const result=p.process(frame(8100,1500));assert.equal(result.corrected[0],8292);assert.equal(result.valid,true);
 const prior=p.reference;
 assert.throws(()=>p.setShutterReference(frames.slice(-7),{shutterClosed:true,referenceCount:8}),/Require8/);
 assert.throws(()=>p.setShutterReference(frames,{shutterClosed:true,referenceCount:4}),/referenceCount/);
 assert.throws(()=>p.setShutterReference(frames,{shutterClosed:true}),/Require16/);
 assert.equal(p.reference,prior);
});
