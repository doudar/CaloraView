'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {applyStartupNuc,calculateFpa}=require('../src/core/nuc-startup.cjs');
test('startup wide multiply preserves overflow and negative floors',()=>{
 const input={raw:new Uint16Array([65535,0,100]),gain:new Uint16Array([65535,65535,32768]),background:new Uint16Array([0,65535,403]),offset:5500,sensorCounts:1500,baseline:1500};
 assert.deepEqual([...applyStartupNuc(input).corrected],[16383,0,5499]);assert.equal(applyStartupNuc({...input,sensorCounts:1513}).driftWarning,true);assert.equal(applyStartupNuc({...input,sensorCounts:1512}).driftWarning,false);
});
test('FPA matches bounded native instructions on own capture and boundaries',t=>{
 const file=path.join(__dirname,'../research/fpa-native-vectors.json');if(!fs.existsSync(file))return t.skip('local native vectors absent');
 for(const item of JSON.parse(fs.readFileSync(file)).cases){const plane=new Uint16Array(49152);item.samples.forEach((n,i)=>plane[i*10*256+255]=n);const got=calculateFpa({plane,width:256,height:192});assert.equal(got.estimate,item.estimate,String(item.index));assert.equal(got.word,item.word);}
});
test('startup own capture matches native digest',t=>{
 const file=path.join(__dirname,'../research/nuc-startup-own-capture.json');if(!fs.existsSync(file))return t.skip('local native vectors absent');
 const report=JSON.parse(fs.readFileSync(file));const frame=fs.readFileSync(path.join(__dirname,'../research/shutter-JEHPUQ/sensor.raw')).subarray(0,117216);const table=fs.readFileSync(path.join(__dirname,'../research/sk02-device-export-20261107/files/KMatrix.bin'));const raw=new Uint16Array(49152),gain=new Uint16Array(49152),background=new Uint16Array(49152);
 for(let y=0,i=0;y<192;y++)for(let x=0;x<256;x++,i++){raw[i]=frame.readUInt16LE(((y+2)*264+x+4)*2);gain[i]=table.readUInt16LE(i*2);background[i]=(raw[i]*4+(i%9)-4)&65535;}
 const got=applyStartupNuc({raw,gain,background,offset:5500,sensorCounts:1526,baseline:1526});const digest=require('node:crypto').createHash('sha256').update(Buffer.from(got.corrected.buffer)).digest('hex');assert.equal(digest,report.correctedSha256);
});
