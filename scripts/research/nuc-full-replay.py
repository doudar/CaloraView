"""Bounded offline IFR_NUC_Process replay. Never sends camera commands.
Strict callback model stops at unresolved wrapper behavior; phase model is explicitly
conditional on recorded command completions, not a mechanical-position measurement.
"""
import argparse,pathlib,struct,json,hashlib,time,collections,math,sys
ROOT=pathlib.Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--calibration',type=pathlib.Path,required=True)
p.add_argument('--capture',type=pathlib.Path,default=ROOT/'research/shutter-JEHPUQ')
p.add_argument('--output',type=pathlib.Path,default=ROOT/'research/temperature-diagnosis/nuc-full-replay.json')
p.add_argument('--callback-model',choices=['strict','recorded-phase'],default='strict')
p.add_argument('--trigger-frame',type=int,default=0,help='Explicit normal key24 request at this replay frame; recorded command start is unavailable')
p.add_argument('--max-seconds',type=int,default=110)
a=p.parse_args()
loader=ROOT/'scripts/research/nuc-tecless-oracle.py';prefix,sep,_=loader.read_text().partition('random.seed(20261107)');assert sep
sys.path.insert(0,str(ROOT/'research/python-deps'))
from unicorn import UC_HOOK_CODE
from unicorn.arm64_const import *
clock={'ns':1000000000,'index':-1,'phase':'initialization'};callbacks=[];host={'collectionStart':None};boundaries=[];frames=[];callback_addresses={};start=time.monotonic();h=0

def ret(value):
 u.reg_write(UC_ARM64_REG_X0,value&0xffffffffffffffff);u.reg_write(UC_ARM64_REG_PC,u.reg_read(UC_ARM64_REG_LR))
def state():
 if not h:return {}
 def n(off,fmt):return struct.unpack('<'+fmt,rd(h+off,struct.calcsize(fmt)))[0]
 return dict(gear=n(0x22,'B'),offset=n(0xde,'H'),phase=n(0x10e,'B'),mode=n(0x10f,'B'),mask=n(0x40,'I'),countTarget=n(0x60a,'B'),count=n(0x60e,'B'),complete=n(0x60f,'B'),A=n(0x610,'B'),B=n(0x611,'B'),baseline=n(0x69c,'h'),cav=n(0x1e,'h'),flags=rd(h+0xec,0x40).hex())
def special(uc,address,size,user):
 if address in diagnostic_addresses:ret(0);return
 if address in callback_addresses:
  name=callback_addresses[address];args=[u.reg_read(UC_ARM64_REG_X0+i)for i in range(5)]
  e=dict(frame=clock['index'],phase=clock['phase'],callback=name,args=args,returnAddress=hex(u.reg_read(UC_ARM64_REG_LR)));callbacks.append(e)
  # MicroDM229690..22971c resets host acquisition queue/status then returns0.
  if name=='wrapper2290f8':e['return']=0;ret(0);return
  if a.callback_model=='recorded-phase' and name=='wrapper22b4cc':
   host['collectionStart']=clock['index'];e['return']=0;e['effect']='Reset host sampling state (MicroDM22b840..22b890)';ret(0);return
  if a.callback_model=='recorded-phase' and name=='wrapper22bc78' and args[0]==6:
   if host['collectionStart'] is None:raise RuntimeError('VB status without doVB')
   delta=abs(host['mean']-8192);e['mean']=host['mean'];e['target']=8192;e['tolerance']=1500
   if delta>1500:raise RuntimeError('VB requires device-side adjustment; saved frames cannot emulate changed hardware')
   e['return']=1;e['evidence']='MicroDM248a60 mean,2460b4 target,248ca0 tolerance,248e34 done';ret(1);return
  if a.callback_model=='recorded-phase' and name=='wrapper22a6d8':
   host['ddacPending']=True;e['return']=0;e['effect']='Host DDAC queued (22aa4c..22aa7c); no device action is simulated';ret(0);return
  if a.callback_model=='recorded-phase' and name=='wrapper22bc78' and args[0]==4 and host.get('ddacPending'):
   e['return']=0;e['conditional']='DDAC completion unknown: remain pending, never invent altered device pixels';ret(0);return
  if a.callback_model=='recorded-phase' and name=='wrapper22bc78' and args[0] in (1,2):
   done=(clock['phase'] in ('closed','opening','opened')) if args[0]==1 else clock['phase']=='opened'
   e['return']=int(done);e['conditional']='Recorded host command completion substitutes for wrapper host status flags';ret(int(done));return
  raise RuntimeError('Unimplemented callback '+name+' '+str(args))
 name=external.get(address)
 if name=='_ZNSt6__ndk16chrono12steady_clock3nowEv':ret(clock['ns']);return
 if name in ('clock_gettime',):
  dest=u.reg_read(UC_ARM64_REG_X1);u.mem_write(dest,struct.pack('<qq',clock['ns']//1000000000,clock['ns']%1000000000));ret(0);return
 if address in stage_addresses:
  boundaries.append(dict(frame=clock['index'],stage=stage_addresses[address],state=state(),args=[u.reg_read(UC_ARM64_REG_X0+i)for i in range(4)]))
# Capture and remove the loader's global hook, then install only bounded
# import/stage/callback hooks; no Python callback is needed for pixel loops.
prefix=prefix.replace('u.hook_add(UC_HOOK_CODE,hook)','original_hook_id=u.hook_add(UC_HOOK_CODE,hook)')
v={'__file__':str(loader),'__name__':'replay_loader'};exec(compile(prefix,str(loader),'exec'),v)
u,alloc,rd,symbols,external=[v[n]for n in ('u','alloc','rd','symbols','external')];u.hook_del(v['original_hook_id'])
stage_names=['NUC_ShutterCtrl','IFR_NUC_Cali_BCaliSendRawImg','IFR_NUC_Cali_BCaliCalcBMatrix','NUC_TECLESS30_Process','NUC_FPN_Process','NUC_BPC_Process','NUC_VignettingCorrection_Process']
stage_addresses={symbols[n]:n for n in stage_names}
diagnostic_addresses={symbols[n] for n in ('nuc_prt_process','nuc_openLogFile')}
for addr in diagnostic_addresses:u.hook_add(UC_HOOK_CODE,special,begin=addr,end=addr)
for addr in stage_addresses:u.hook_add(UC_HOOK_CODE,special,begin=addr,end=addr)
for addr,name in external.items():u.hook_add(UC_HOOK_CODE,special if name in ('_ZNSt6__ndk16chrono12steady_clock3nowEv','clock_gettime') else v['hook'],begin=addr,end=addr)
for offset,wrapper in [(0x28,0x2290f8),(0x30,0x229868),(0x40,0x22a6d8),(0x48,0x22add8),(0x50,0x22b4cc),(0x58,0x22bc78),(0x60,0x22de6c),(0x68,0x22e294)]:
 addr=0x4008000+offset;callback_addresses[addr]='wrapper'+format(wrapper,'x');u.mem_write(addr,b'\xc0\x03\x5f\xd6');u.hook_add(UC_HOOK_CODE,special,begin=addr,end=addr)
def call(name,*args):
 if time.monotonic()-start>a.max_seconds:raise TimeoutError('Overall replay wall-time limit')
 u.reg_write(UC_ARM64_REG_SP,0x30ff000);u.reg_write(UC_ARM64_REG_LR,v['sentinel'])
 for i,value in enumerate(args):u.reg_write(UC_ARM64_REG_X0+i,value)
 u.emu_start(symbols[name],v['sentinel'],timeout=8000000,count=20000000)
 if u.reg_read(UC_ARM64_REG_PC)!=v['sentinel']:raise TimeoutError(name+' per-call time/instruction bound at '+hex(u.reg_read(UC_ARM64_REG_PC)))
 r=u.reg_read(UC_ARM64_REG_X0)&0xffffffff;return r if r<0x80000000 else r-0x100000000
report=dict(callbackModel=a.callback_model,librarySha256=hashlib.sha256(v['LIB'].read_bytes()).hexdigest(),capture=str(a.capture),calibration=str(a.calibration),complete=False,productionChanges=False,triggerFrame=a.trigger_frame,limitations=['Explicit host trigger time is a replay parameter, not captured Android state','Recorded host completion phases substitute for Android callback flags; DDAC remains pending','Diagnostic file/log functions suppressed; no image-state callback is silently accepted'])
try:
 resource=(ROOT/'research/nuc-resource-101c690.bin').read_bytes();rp=alloc(resource);cap=alloc(24);assert call('IFR_NUC_GetNucCapInfo',rp,cap)==0
 ability=bytearray(0xa0);struct.pack_into('<III',ability,0,256,192,6);ability[16:32]=rd(cap,16);ability[32:40]=rd(cap+16,8)
 for addr,name in callback_addresses.items():struct.pack_into('<Q',ability,addr-0x4008000,addr)
 ap=alloc(ability);table=alloc(48);out=alloc(8);assert call('IFR_NUC_GetMemSize',ap,table)==0
 for off in (0,24):u.mem_write(table+off,struct.pack('<Q',alloc(struct.unpack('<I',rd(table+off+8,4))[0])))
 assert call('IFR_NUC_Create',ap,table,out)==0;h=struct.unpack('<Q',rd(out,8))[0]
 assert call('IFR_NUC_SetConfig',h,3,rp,len(resource))==0
 param=alloc(8)
 for key,value in [(31,1),(30,1),(6,1),(532,1),(26,1),(27,1),(84,1),(85,1),(513,3)]:
  u.mem_write(param,struct.pack('<II',key,value));assert call('IFR_NUC_SetConfig',h,1,param,8)==0,(key,value)
 assert call('IFR_NUC_UpdateParams',h)==0
 gain=alloc((a.calibration/'KMatrix2.bin').read_bytes());bpm=(a.calibration/'BPM.bin').read_bytes();assert call('IFR_NUC_Cali_BPC_BPList2BPCaliMask',h,alloc(bpm+bytes(16384-len(bpm))))==0
 assert call('IFR_NUC_Cali_VignettingCorrection_SetMatrix',h,alloc((a.calibration/'VC.bin').read_bytes()))==0
 rawp=alloc(98304);background=alloc(98304);extra=alloc(98304);geometry=alloc(struct.pack('<IIIIQ',256,192,6,0,rawp));frameio=alloc(0xb8);flags=alloc(0x30)
 report['initialState']=state();report['abilityHex']=ability.hex()
 timeline=json.loads((a.capture/'timeline.json').read_text())['timeline'];raw=(a.capture/'sensor.raw').read_bytes();assert len(raw)==len(timeline)*117216
 report['inputFrames']=len(timeline);report['rawSha256']=hashlib.sha256(raw).hexdigest()
 for entry in timeline:
  index=entry['index'];clock.update(index=index,phase=entry['phase'],ns=1000000000+(entry['timestamp']-timeline[0]['timestamp'])*1000000)
  if index==a.trigger_frame:
   u.mem_write(param,struct.pack('<II',24,1));assert call('IFR_NUC_SetConfig',h,1,param,8)==0
  frame=raw[index*117216:(index+1)*117216];crop=b''.join(frame[(y+2)*528+8:(y+2)*528+520]for y in range(192));u.mem_write(rawp,crop)
  pixels=struct.unpack('<49152H',crop);host['mean']=sum(pixels)//49152
  def f32(x):return struct.unpack('<f',struct.pack('<f',x))[0]
  mean=f32(f32(sum(pixels[y*256+255]for y in range(0,192,10)))/f32(20));fpa=f32(f32(f32(f32(mean*f32(.146)+800)-2000)/10)+25);fpaWord=(math.trunc(fpa)*50)&65535
  fio=bytearray(0xb8);struct.pack_into('<QQ',fio,0x78,background,gain);struct.pack_into('<Q',fio,0x90,extra);cav=struct.unpack_from('<H',frame,114050)[0];struct.pack_into('<HH',fio,0xa2,fpaWord,cav);u.mem_write(frameio,bytes(fio));u.mem_write(flags,bytes(0x30))
  r=call('IFR_NUC_Process',h,geometry,frameio,flags)
  b=rd(background,98304);image=rd(rawp,98304)
  frames.append(dict(index=index,timestamp=entry['timestamp'],recordedPhase=entry['phase'],status=r,state=state(),outputFlags=rd(flags,0x30).hex(),backgroundSha256=hashlib.sha256(b).hexdigest(),backgroundFirst=struct.unpack('<8H',b[:16]),correctedSha256=hashlib.sha256(image).hexdigest(),correctedFirst=struct.unpack('<8H',image[:16])))
 report['complete']=True
 report['calibrationReady']=bool(rd(h+0xed,1)[0]);report['hostState']=host;report['processedFrames']=len(frames)
 report['stageCounts']=dict(collections.Counter(x['stage'] for x in boundaries))
except Exception as e:
 report['error']=str(e);report['pc']=hex(u.reg_read(UC_ARM64_REG_PC));report['stoppedFrame']=clock['index'];report['stoppedState']=state()
finally:
 report.update(frames=frames,callbacks=callbacks,boundaries=boundaries,elapsedSeconds=time.monotonic()-start)
 a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(report,indent=2),encoding='utf-8',newline='\n');print(json.dumps({k:v for k,v in report.items()if k not in ('frames','boundaries','abilityHex','callbacks')},indent=2))
