"""Native acquisition -> startup NUC -> FPN -> BPC -> VC versus JS, retaining VC history."""
import pathlib,struct,json,subprocess,contextlib,io,hashlib,argparse
ROOT=pathlib.Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--calibration',type=pathlib.Path,required=True);p.add_argument('--serial',required=True);p.add_argument('--reference',type=pathlib.Path,required=True);p.add_argument('--scene',type=pathlib.Path,required=True);args=p.parse_args();cal=args.calibration.resolve()
loader=ROOT/'scripts/research/nuc-downstream-oracle.py'
prefix,sep,_=loader.read_text().partition('# Compare production JS');assert sep
v={'__file__':str(loader)}
with contextlib.redirect_stdout(io.StringIO()):exec(compile(prefix,str(loader),'exec'),v)
u,alloc,rd,call,h=[v[n] for n in ('u','alloc','rd','call','handle')]
param=alloc(struct.pack('<II',513,3));assert call('IFR_NUC_SetConfig',h,1,param,8)==0;assert call('IFR_NUC_UpdateParams',h)==0
gain=alloc((cal/'KMatrix2.bin').read_bytes());bpmbytes=(cal/'BPM.bin').read_bytes();bpm=alloc(bpmbytes+bytes(16384-len(bpmbytes)));assert call('IFR_NUC_Cali_BPC_BPList2BPCaliMask',h,bpm)==0
vcbytes=(cal/'VC.bin').read_bytes();assert len(vcbytes)==98304;vcp=alloc(vcbytes);assert call('IFR_NUC_Cali_VignettingCorrection_SetMatrix',h,vcp)==0
refpath=args.reference.resolve()
scenepath=args.scene.resolve()
refs=refpath.read_bytes();scenes=scenepath.read_bytes()
def crop(frame):return b''.join(frame[(y+2)*528+8:(y+2)*528+520]for y in range(192))
rawp=alloc(98304);vcout=alloc(98304);frameinfo=alloc(16);phase=alloc(1);background=alloc(98304)
assert call('IFR_NUC_Cali_BCaliInit',h)==0
for i in range(len(refs)//117216-16,len(refs)//117216):
 frame=refs[i*117216:(i+1)*117216];sensor=struct.unpack_from('<H',frame,114050)[0];sensor=sensor if sensor<8192 else 8192-sensor
 u.mem_write(rawp,crop(frame));u.mem_write(frameinfo,struct.pack('<QhBB',rawp,sensor,0,1));assert call('IFR_NUC_Cali_BCaliSendRawImg',h,frameinfo,phase)==0
assert call('IFR_NUC_Cali_BCaliCalcBMatrix',h,background)==0
assert rd(h+0xed,1)==b'\1';assert struct.unpack('<H',rd(h+0xde,2))[0]==8192
outputs=[alloc(8)for _ in range(4)];cases=[];indices=[0,10,20,30,44];natives=[]
for index in indices:
 frame=scenes[index*117216:(index+1)*117216];sensor=struct.unpack_from('<H',frame,114050)[0];sensor=sensor if sensor<8192 else 8192-sensor
 u.mem_write(rawp,crop(frame));assert call('NUC_TECLESS30_Process',h,rawp,gain,background,sensor,*outputs)==0
 assert call('NUC_FPN_Process',h,rawp)==0;assert call('NUC_BPC_Process',h,rawp)==0;assert call('NUC_VignettingCorrection_Process',h,rawp,vcout)==0
 native=rd(vcout,98304);natives.append(native)
 cases.append(dict(frame=index,sha256=hashlib.sha256(native).hexdigest(),nativeInvalid=rd(outputs[3],1)[0],nativeDrift=rd(outputs[2],1)[0],vcAlpha=struct.unpack('<q',rd(h+0x528,8))[0]))
js="""const fs=require('fs');const {createFactoryProcessor}=require('./src/core/factory-processor.cjs');const q=JSON.parse(fs.readFileSync(0));const p=createFactoryProcessor({calibrationFolder:q.calibration,expectedSerial:q.serial});const b=fs.readFileSync(q.reference);p.setShutterReference(Array.from({length:b.length/117216},(_,i)=>b.subarray(i*117216,(i+1)*117216)),{shutterClosed:true});const scene=fs.readFileSync(q.scene);for(const i of q.indices){const r=p.process(scene.subarray(i*117216,(i+1)*117216));if(!r.valid)throw Error(r.reason);process.stdout.write(Buffer.from(r.corrected.buffer));}"""
result=subprocess.run(['node','-e',js],input=json.dumps(dict(serial=args.serial,calibration=str(cal),reference=str(refpath),scene=str(scenepath),indices=indices)).encode(),cwd=ROOT,capture_output=True,check=True).stdout
assert len(result)==98304*len(indices)
for n,index in enumerate(indices):
 actual=result[n*98304:(n+1)*98304];native=natives[n]
 if actual!=native:
  a,b=struct.unpack('<49152H',native),struct.unpack('<49152H',actual);diff=[(i,x,y)for i,(x,y)in enumerate(zip(a,b))if x!=y];raise AssertionError((index,len(diff),diff[:10]))
report=dict(allMatched=True,pixels=49152*len(cases),gear=rd(h+0x22,1)[0],offset=8192,baseline=struct.unpack('<h',rd(h+0x69c,2))[0],stages=['native16frameacquisition','startupNUC','FPN','BPC','VC'],vcSha256=hashlib.sha256(vcbytes).hexdigest(),vcHistoryPreserved=True,cases=cases)
(ROOT/'research/factory-startup-own-capture-reference.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
