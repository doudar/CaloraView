'use strict';
// Compare an ignored local oracle report. No hardware or native library loading.
const fs=require('node:fs');
const {prepareEnvironment,blackbodyToObject}=require('../../src/core/radiometry-environment.cjs');
const [calibrationPath,reportPath]=process.argv.slice(2);
if(!calibrationPath||!reportPath)throw new Error('Usage: node scripts/research/check-environment-reference.cjs <calibration.bin> <reference.json>');
const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));const cal=fs.readFileSync(calibrationPath);
if(report.syntheticAtmosphere){
 [[1,1,0],[.5,20,2],[2,100,-3]].forEach((model,i)=>{model.forEach((v,j)=>cal.writeFloatLE(v,0x21ac+i*32+j*4));for(let j=0;j<3;j++)cal.writeFloatLE(0,0x3680+i*16+j*4);cal.writeFloatLE(0,0x3758+i*16);});cal.writeFloatLE(0,0x3784);cal.writeFloatLE(0,0x3788);
}
let failures=0;for(const c of report.cases){const e=prepareEnvironment(cal,c.environment),o=blackbodyToObject(c.blackbodyC,e);if(e.status!==c.transmissionStatus||e.tau!==c.tau||o.status!==(c.status??c.transmissionStatus)||o.celsius!==(c.celsius??null)){if(failures<3)console.error({reference:c,environment:e,object:o});failures++;}}
console.log(JSON.stringify({cases:report.cases.length,failures,exact:failures===0}));process.exitCode=failures?1:0;
