'use strict';
// Exercises the production Node worker using saved corrected scalar input only.
const {Worker}=require('node:worker_threads');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {transformPreview}=require('../../src/core/display-transform.cjs');
const root=path.resolve(__dirname,'../..'),folder=path.join(root,'research/neural-sr');
function response(worker){return new Promise((resolve,reject)=>{
 const timeout=setTimeout(()=>finish(new Error('Worker response exceeded20seconds')),20000);
 const message=value=>finish(null,value),error=err=>finish(err),exit=code=>finish(new Error(`Unexpected exit${code}`));
 function finish(err,value){clearTimeout(timeout);worker.off('message',message);worker.off('error',error);worker.off('exit',exit);err?reject(err):resolve(value)}
 worker.once('message',message);worker.once('error',error);worker.once('exit',exit);
})}
function delta(a,b){let sum=0;for(let i=0;i<a.length;i++)sum+=Math.abs(a[i]-b[i]);return sum/a.length}
function summary(a){const sorted=[...a].sort((a,b)=>a-b);return {mean:a.reduce((a,b)=>a+b,0)/a.length,p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1)}}
(async()=>{
 const worker=new Worker(path.join(root,'src/core/neural-worker.cjs'));
 try{
  const ready=await response(worker);if(ready.type!=='ready')throw new Error(JSON.stringify(ready));
  const inputs=fs.readdirSync(path.join(folder,'real-input')).filter(f=>f.endsWith('.pgm')).sort();
  const report={researchOnly:true,node:process.version,ort:require('onnxruntime-node/package.json').version,ready,frames:[],temporalCaveat:'Consecutive-frame difference includes real motion and auto-level changes; it is not an isolated flicker or accuracy metric.'};
  let previousInput,previousOutput,previousBicubic;
  const rawFile=path.join(folder,'real-output/node-worker-output.f32');const fd=fs.openSync(rawFile,'w');
  try{for(let index=0;index<inputs.length;index++){
   const bytes=fs.readFileSync(path.join(folder,'real-input',inputs[index]));const pixels=bytes.subarray(bytes.length-49152);
   const gray=Float32Array.from(pixels,p=>p/255),rgba=Buffer.alloc(49152*4);
   for(let i=0;i<gray.length;i++){rgba[i*4]=pixels[i];rgba[i*4+1]=pixels[i];rgba[i*4+2]=pixels[i];rgba[i*4+3]=255}
   const bicubicFrame=transformPreview({rgba,width:256,height:192,stats:{}},{resolution:'enhanced',rotation:0});
   const bicubic=Float32Array.from({length:196608},(_,i)=>bicubicFrame.rgba[i*4]/255);
   const start=performance.now(),pending=response(worker);worker.postMessage({id:index,gray});const result=await pending;const totalMs=performance.now()-start;
   if(result.type!=='result'||result.id!==index)throw new Error(JSON.stringify(result));
   const frame={index,totalMs,inferenceMs:result.inferenceMs,modelSha256:result.modelSha256,outputSha256:crypto.createHash('sha256').update(Buffer.from(result.gray.buffer)).digest('hex')};
   if(previousInput){frame.inputTemporalMAE=delta(gray,previousInput);frame.bicubicTemporalMAE=delta(bicubic,previousBicubic);frame.neuralTemporalMAE=delta(result.gray,previousOutput)}
   fs.writeSync(fd,Buffer.from(result.gray.buffer));report.frames.push(frame);previousInput=gray;previousOutput=result.gray;previousBicubic=bicubic;
  }}finally{fs.closeSync(fd)}
  report.inferenceMs=summary(report.frames.map(f=>f.inferenceMs));report.roundTripMs=summary(report.frames.map(f=>f.totalMs));
  report.temporal={input:summary(report.frames.slice(1).map(f=>f.inputTemporalMAE)),bicubic:summary(report.frames.slice(1).map(f=>f.bicubicTemporalMAE)),neural:summary(report.frames.slice(1).map(f=>f.neuralTemporalMAE))};
  fs.writeFileSync(path.join(folder,'real-output/node-worker-benchmark.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,frames:report.frames.length},null,2));
 }finally{await worker.terminate()}
})().catch(error=>{console.error(error);process.exitCode=1});
