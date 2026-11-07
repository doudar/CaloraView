'use strict';
// Offline saved-camera input shared by the SR candidate benchmarks.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createFactoryProcessor } = require('../../src/core/factory-processor.cjs');
const { decodeFrame } = require('../../src/core/thermal.cjs');
const root = path.resolve(__dirname, '../..'), out = path.join(root, 'research/neural-sr/real-input');
const [cache, serial, refPath, scenePath] = process.argv.slice(2);
if (!cache || !serial || !refPath || !scenePath) throw new Error('Usage: node scripts/research/benchmark-real-frames.cjs <calibration-directory> <serial> <shutter.raw> <scene.raw>');
const ref = fs.readFileSync(refPath), scene = fs.readFileSync(scenePath), size = 117216;
const factory = createFactoryProcessor({calibrationFolder:cache, expectedSerial:serial});
factory.setShutterReference(Array.from({length:ref.length/size},(_,i)=>ref.subarray(i*size,(i+1)*size)),{shutterClosed:true});
fs.mkdirSync(out,{recursive:true});
const frames=[];
for(let i=0;i<scene.length/size;i++) {
  const raw=scene.subarray(i*size,(i+1)*size), result=factory.process(raw);
  if(!result.valid) throw new Error(result.reason);
  const frame=decodeFrame(raw,{factoryPlane:result.corrected,palette:'gray'});
  const gray=Buffer.alloc(49152); for(let j=0;j<gray.length;j++)gray[j]=frame.rgba[j*4];
  const name=`frame-${String(i).padStart(3,'0')}.pgm`;
  fs.writeFileSync(path.join(out,name),Buffer.concat([Buffer.from('P5\n256 192\n255\n'),gray]));
  frames.push({name,sha256:crypto.createHash('sha256').update(gray).digest('hex')});
}
fs.writeFileSync(path.join(out,'provenance.json'),JSON.stringify({researchOnly:true,serial,refPath,scenePath,referenceSha256:crypto.createHash('sha256').update(ref).digest('hex'),sceneSha256:crypto.createHash('sha256').update(scene).digest('hex'),normalization:'Per-frame 1st–99th percentile, production decodeFrame gray palette',width:256,height:192,frames},null,2));
console.log(JSON.stringify({out,frames:frames.length}));
