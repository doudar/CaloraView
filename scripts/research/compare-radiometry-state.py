"""Local-only native/portable differential validation; no vendor data is shipped.

Supply the actual calibration and compact metadata. Native MT_* calls execute in
the bounded ARM oracle; the portable implementation is invoked through Node.
Distance follows the traced MicroTA SDK boundary: UI1m -> Q13 8192 -> native
point float1, global config1000; MTlib applies its internal .001 scale.
"""
import argparse, pathlib, sys, runpy, struct, subprocess, json, hashlib
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--calibration',type=pathlib.Path,required=True)
p.add_argument('--metadata',type=pathlib.Path,required=True)
p.add_argument('--output',type=pathlib.Path)
p.add_argument('--range',type=int,choices=(0,1,2),default=0)
a=p.parse_args();root=pathlib.Path(__file__).resolve().parents[2]
sys.argv=['oracle','--calculator','float-online','--library',str(root/'research/decompiled/resources/lib/arm64-v8a/libMTlib.so'),'--calibration',str(a.calibration),'--metadata',str(a.metadata),'--width','256','--height','192','--ambient','20','--reflected','20','--humidity','60','--distance','1','--emissivity','.97','--gray','9447']
m=runpy.run_path(str(root/'scripts/research/mtlib-oracle.py'),run_name='oracle_module')
u,alloc,call=m['u'],m['alloc'],m['call']
def checked(name,*args):
 status=call(name,*args)
 if status:raise RuntimeError((name,status))
ability=alloc(struct.pack('<4I',256,192,0,0));mem=alloc(48)
checked('MT_GetMemSize_OL',ability,mem)
for off in (0,24):u.mem_write(mem+off,struct.pack('<Q',alloc(m['u32'](mem+off+8))))
out=alloc(8);checked('MT_Create_OL',ability,mem,out);h=m['u64'](out)
checked('MT_SetCalibParam',h,alloc(m['calibration_bytes']))
config=alloc(8)
def cfg(k,v):
 u.mem_write(config,struct.pack('<ii',k,v));checked('MT_SetConfig_OL',h,1,config,8)
for k,v in ((5,20000),(6,60000),(7,1000),(13,0),(15,83),(29,0),(35,6)):cfg(k,v)
meta=bytearray(m['metadata_bytes']);mp=alloc(len(meta));point=alloc(36);image=alloc(256*192*2+len(meta))
struct.pack_into('<H',meta,26,a.range)
last_bb=[]
def bb_hook(uc,addr,size,user):last_bb.append(struct.unpack('<f',struct.pack('<I',u.reg_read(m['UC_ARM64_REG_S0'])))[0])
va=m['symbols']['MT_BBtemp2Objtemp'];u.hook_add(m['UC_HOOK_CODE'],bb_hook,begin=va,end=va)
cases=[]
for mode in ('addl','core'):
 for ambient in (10,20,30):
  cfg(5,ambient*1000)
  for cav in (500,1000,1250,1526,2000,2500):
   struct.pack_into('<H',meta,2,cav);u.mem_write(mp,bytes(meta))
   if mode=='addl':checked('MT_SetAddlParam',h,mp)
   else:
    u.mem_write(image+256*192*2,bytes(meta));checked('MT_SetConfig_OL',h,7,image,256*192*2+len(meta))
   for gray in (5000,6000,7265,8192,9000,9447,12000,16069):
    last_bb.clear();u.mem_write(point,struct.pack('<4I4fi',0,gray,0,0,0,.97,20,1,0))
    status=call('MT_Process_OL',h,0,point,1)
    def sf(o):return struct.unpack('<f',m['rd'](h+o,4))[0]
    cases.append({'mode':mode,'ambient':ambient,'cav':cav,'gray':gray,'metadata':bytes(meta).hex(),'status':status,
      'pointStatus':m['s32'](point),'celsius':struct.unpack('<f',m['rd'](point+16,4))[0],'bb':last_bb[-1] if last_bb else None,'nativeAmbient':sf(0xd0),'nativeHumidity':sf(0xd4),
      'state':{'linear':sf(0x74),'quadratic':sf(0x78),'baseGray':m['s32'](h+0x44),'referenceGray':m['s32'](h+0x40),
      'planck':dict(zip(('a','b','c','d'),(sf(x) for x in (0x7c,0x80,0x84,0x88))))}})
js="""const fs=require('fs'), r=require('./src/core/radiometry-state.cjs'),e=require('./src/core/radiometry-environment.cjs'),{grayToObject}=require('./src/core/radiometry.cjs');const input=JSON.parse(fs.readFileSync(0,'utf8'));const c=Buffer.from(input.calibration,'hex');console.log(JSON.stringify(input.cases.map(x=>{const settings=e.normalizeSdkEnvironment({ambientC:x.ambient});const state=r.prepareRadiometry(c,Buffer.from(x.metadata,'hex'),settings);const bb=r.grayToBlackbody(x.gray,state);const env=e.prepareEnvironment(c,{...settings,range:state.range});return {state,bb,point:grayToObject(x.gray,state,env)}})));"""
result=subprocess.run(['node','-e',js],cwd=root,input=json.dumps({'calibration':m['calibration_bytes'].hex(),'cases':cases}),text=True,capture_output=True,check=True)
portable=json.loads(result.stdout);errors=[]
for i,(n,j) in enumerate(zip(cases,portable)):
 for k,v in n['state'].items():
  if v!=j['state'][k]:errors.append({'case':i,'field':k,'native':v,'portable':j['state'][k]})
 if n['bb']!=j['bb']['celsius']:errors.append({'case':i,'field':'blackbody','native':n['bb'],'portable':j['bb']})
 if n['pointStatus']!=j['point']['status']:errors.append({'case':i,'field':'pointStatus','native':n['pointStatus'],'portable':j['point']['status']})
 if n['pointStatus']==0 and n['celsius']!=j['point']['celsius']:errors.append({'case':i,'field':'objectCelsius','native':n['celsius'],'portable':j['point']['celsius'],'ambient':n['nativeAmbient'],'humidity':n['nativeHumidity']})
report={'cases':len(cases),'range':a.range,'errors':errors,'calibrationSha256':hashlib.sha256(m['calibration_bytes']).hexdigest(),'sceneAccuracyValidated':False}
if a.output:a.output.write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2));sys.exit(bool(errors))
