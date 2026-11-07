"""Local native FPN/vignetting reference; never packaged with the app."""
import pathlib,struct,json,sys
loader=pathlib.Path(__file__).with_name('nuc-tecless-oracle.py')
prefix,sep,_=loader.read_text().partition('random.seed(20261107)')
if not sep:raise RuntimeError('Native loader boundary changed')
v={'__file__':str(loader),'__name__':'downstream_loader'}
exec(compile(prefix,str(loader),'exec'),v)
u,alloc,call,rd=[v[n] for n in ('u','alloc','call','rd')]
root=loader.resolve().parents[2]
resource=(root/'research/nuc-resource-101c690.bin').read_bytes()
rp=alloc(resource);cap=alloc(24)
assert call('IFR_NUC_GetNucCapInfo',rp,cap)==0
ability=bytearray(48)
struct.pack_into('<III',ability,0,256,192,6)
ability[16:24]=rd(cap,8);ability[32:40]=rd(cap+16,8)
ap=alloc(ability);table=alloc(48);out=alloc(8)
assert call('IFR_NUC_GetMemSize',ap,table)==0
for offset in (0,24):
 size=struct.unpack('<I',rd(table+offset+8,4))[0]
 u.mem_write(table+offset,struct.pack('<Q',alloc(size)))
assert call('IFR_NUC_Create',ap,table,out)==0
handle=struct.unpack('<Q',rd(out,8))[0]
assert call('IFR_NUC_SetConfig',handle,3,rp,len(resource))==0
print(json.dumps({'handle':hex(handle),'FPN':rd(handle+0x4d0,16).hex(),'VC':rd(handle+0x50c,76).hex(),'mask':rd(handle+0x40,8).hex()}))
(root/'research/nuc-downstream-initial-handle.bin').write_bytes(rd(handle,0x7f8))

# Compare production JS with native using deterministic synthetic scenes.
import subprocess,hashlib
cases=[]
for case in range(8):
 values=[]
 for y in range(192):
  for x in range(256):
   base=5500+(x//32)*100+(y//48)*40
   if case==0:value=base
   elif case==1:value=base+(x%7)-3
   elif case==2:value=base+((x*7+y*11)%23)-11
   elif case==3:value=base+((x*29+y*43)%601)-300
   elif case==4:value=(x*157+y*71)%16384
   elif case==5:value=(x%2)*16383
   elif case==6:value=(x+y)%9
   else:value=16375+(x+y)%9
   values.append(value)
 raw=struct.pack('<49152H',*values);image=alloc(raw)
 assert call('NUC_FPN_Process',handle,image)==0
 native=rd(image,len(raw))
 js="const fs=require('fs'),crypto=require('crypto');const {correctFixedPattern}=require('./src/core/nuc-fpn.cjs');let b=fs.readFileSync(0);let a=new Uint16Array(b.length/2);for(let i=0;i<a.length;i++)a[i]=b.readUInt16LE(i*2);const r=correctFixedPattern(a);process.stdout.write(Buffer.from(r.corrected.buffer));"
 result=subprocess.run(['node','-e',js],input=raw,cwd=root,capture_output=True,check=True).stdout
 if result!=native:
  a=struct.unpack('<49152H',native);b=struct.unpack('<49152H',result)
  differences=[(i,x,y) for i,(x,y) in enumerate(zip(a,b)) if x!=y]
  raise AssertionError((case,len(differences),differences[:15]))
 cases.append(dict(case=case,pixels=49152,sha256=hashlib.sha256(native).hexdigest()))
print(json.dumps(dict(fpnAllMatched=True,cases=cases)))
(root/'research/nuc-fpn-reference.json').write_text(json.dumps(cases,indent=2))
