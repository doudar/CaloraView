'use strict';
const fs=require('node:fs'),path=require('node:path');
const {validateExport}=require('./calibration-export.cjs');
const {VignettingCorrection}=require('./nuc-vignetting.cjs');
const crypto=require('node:crypto');
const {decodeSensorWord,CAV_OFFSET}=require('./frame-metadata.cjs');
const {summarizeAcceptedShutterFrames}=require('./shutter-background.cjs');
const {applyStartupNuc,calculateFpa}=require('./nuc-startup.cjs');
const {correctFixedPattern}=require('./nuc-fpn.cjs');
const {parseBadPixels,correctIsolatedBadPixels}=require('./bad-pixels.cjs');
const {extractCompactAdditional,rewriteSk02HostHeader,applyResolvedHostValidity}=require('./host-metadata.cjs');
const PIXELS=49152,FRAME_BYTES=117216;
function extractPlane(raw){if(!Buffer.isBuffer(raw)||raw.length!==FRAME_BYTES)throw new RangeError('Expected one complete SK02 raw frame');const out=new Uint16Array(PIXELS);for(let y=0,i=0;y<192;y++)for(let x=0;x<256;x++,i++)out[i]=raw.readUInt16LE(((y+2)*264+x+4)*2);return out;}
function u16(bytes){if(!Buffer.isBuffer(bytes)||bytes.length!==98304)throw new RangeError('Factory gain plane must be98304 bytes');const out=new Uint16Array(PIXELS);for(let i=0;i<PIXELS;i++)out[i]=bytes.readUInt16LE(i*2);return out;}
class FactoryProcessor {
 constructor({gain2,badPixels,vignettingCorrection=null}){this.gain=u16(gain2);this.badPixels=parseBadPixels(badPixels);this.vignettingCorrection=vignettingCorrection;this.reference=null;this.cachedCav=0;}
 setShutterReference(rawFrames,{shutterClosed=false,referenceCount=16}={}) {
  if(!shutterClosed)throw new Error('Reference frames must be confirmed inside the closed-shutter capture window');
  if(![8,16].includes(referenceCount))throw new RangeError('referenceCount must be8 or16');
  if(!Array.isArray(rawFrames)||rawFrames.length<referenceCount||rawFrames.length>64)throw new RangeError(`Require${referenceCount}..64 closed-shutter raw frames`);
  const selected=rawFrames.slice(-referenceCount),frames=selected.map(extractPlane),sensorSamples=new Int16Array(referenceCount);
  for(let i=0;i<referenceCount;i++){const word=selected[i].readUInt16LE(CAV_OFFSET);if(!word||word>0x3fff)throw new Error('Shutter reference has missing or invalid CAV');sensorSamples[i]=decodeSensorWord(word);}
  this.reference=summarizeAcceptedShutterFrames({frames,sensorSamples,baselineSource:'acquisition',referenceCount});
  this.cachedCav=selected[referenceCount-1].readUInt16LE(CAV_OFFSET);
  return {acceptedFrames:referenceCount,offeredFrames:rawFrames.length,sensorBaseline:this.reference.sensorBaseline,gear:3,offset:8192,gain:'KMatrix2.bin',eligibility:`app-confirmed-closed-window-last${referenceCount}`,nativeControllerEquivalent:false};
 }
 process(raw,{shutterBusy=false}={}) {
  const plane=extractPlane(raw),incoming=raw.readUInt16LE(CAV_OFFSET);
  if(!incoming)return {valid:false,reason:'missing-sensor-word',corrected:null,metadata:null};
  if(incoming>0x3fff)return {valid:false,reason:'unsupported-sensor-word',corrected:null,metadata:null};
  if(incoming)this.cachedCav=incoming;
  if(!this.reference||!this.cachedCav)return {valid:false,reason:'shutter-reference-required',corrected:null,metadata:null};
  const sensorCounts=decodeSensorWord(this.cachedCav),fpa=calculateFpa({plane,width:256,height:192});
  const nuc=applyStartupNuc({raw:plane,gain:this.gain,background:this.reference.backgroundQuarter,offset:8192,sensorCounts,baseline:this.reference.sensorBaseline});
  let corrected=correctIsolatedBadPixels(correctFixedPattern(nuc.corrected).corrected,this.badPixels);
  let reason=shutterBusy?'shutter-active':nuc.invalidPattern?'invalid-detector-pattern':nuc.driftWarning?'sensor-drift-needs-reference':null;
  if(this.vignettingCorrection){const result=this.vignettingCorrection(corrected);corrected=result instanceof Uint16Array?result:result.corrected;if(!(corrected instanceof Uint16Array)||corrected.length!==PIXELS)throw new Error('Invalid vignetting stage output');}
  else reason=reason||'vignetting-stage-required';
  let metadata=rewriteSk02HostHeader(extractCompactAdditional(raw),{sensorIdentity:'065356A000',fpaWord:fpa.word,cachedCavWord:this.cachedCav,processorSelector:3});
  metadata=applyResolvedHostValidity(metadata,reason?1:0);
  return {corrected,metadata,valid:!reason,reason,diagnostics:{gear:3,gain:'KMatrix2.bin',offset:8192,sensorCounts,sensorBaseline:this.reference.sensorBaseline,fpaWord:fpa.word,fpaEstimate:fpa.estimate,driftWarning:nuc.driftWarning,nativeControllerEquivalent:false}};
 }
}
function createFactoryProcessor({calibrationFolder,expectedSerial,vignettingCorrection=null}) {
 const report=validateExport(calibrationFolder,{expectedSerial});if(!report.valid)throw new Error('Invalid camera calibration: '+report.errors.join('; '));
 function checkedRead(name){const entry=report.files.find(file=>file.name===name);if(!entry||!entry.valid)throw new Error('Missing verified calibration file: '+name);const file=path.join(calibrationFolder,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==entry.bytes)throw new Error('Calibration file changed after validation');const bytes=fs.readFileSync(file);if(crypto.createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error('Calibration file changed after validation');return bytes;}
 if(!vignettingCorrection&&report.files.some(file=>file.name==='VC.bin'&&file.valid)) {
  const bytes=checkedRead('VC.bin');if(bytes.length!==98304)throw new Error('VC map must contain exactly49152 signed16 samples');const map=new Int16Array(PIXELS);for(let i=0;i<PIXELS;i++)map[i]=bytes.readInt16LE(i*2);const vc=new VignettingCorrection(map);vignettingCorrection=image=>vc.process(image);
 }
 return new FactoryProcessor({gain2:checkedRead('KMatrix2.bin'),badPixels:checkedRead('BPM.bin'),vignettingCorrection});
}
module.exports={createFactoryProcessor,FactoryProcessor,extractPlane};
