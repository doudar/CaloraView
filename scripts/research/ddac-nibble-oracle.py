"""Offline differential of MicroDM DDAC nibble arithmetic only; no device I/O.
Does not simulate detector response or prove full calibration equivalence.
"""
import pathlib,sys,struct,hashlib,json,random
ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'research/python-deps'))
from unicorn import Uc,UC_ARCH_ARM64,UC_MODE_ARM
from unicorn.arm64_const import *
from elftools.elf.elffile import ELFFile
lib=ROOT/'research/decompiled/resources/lib/arm64-v8a/libMicroDM_Release_v8a.so'
u=Uc(UC_ARCH_ARM64,UC_MODE_ARM)
u.mem_map(0x240000,0x10000)
with lib.open('rb') as f:
 e=ELFFile(f)
 for seg in e.iter_segments():
  if seg['p_type']=='PT_LOAD' and seg['p_vaddr']<=0x247000<seg['p_vaddr']+seg['p_filesz']:
   f.seek(seg['p_offset']+0x247000-seg['p_vaddr']);u.mem_write(0x247000,f.read(0x1000));break
 else:raise RuntimeError('code segment absent')
base=0x10000000;u.mem_map(base,0x100000)
sp=base+0x1000;ref=base+0x2000;host=base+0x3000;raw=base+0x10000;nibbles=base+0x40000
u.mem_write(ref,struct.pack('<Q',host));u.mem_write(host+0x4a0,struct.pack('<Q',raw))
rng=random.Random(20261107);results=[]
for target in (2500,5500,8192):
 for step in (500,501,999,1000,4096):
  count=264*20
  values=[rng.randrange(65536)for _ in range(count)]
  edges=[target,target+step//2,target-step//2,target+step//2-1,target-step//2+1,0,65535]
  values[:len(edges)]=edges
  for initial in (10,0,15):
   u.mem_write(sp,bytes(0x100));u.mem_write(sp+0x74,struct.pack('<I',step));u.mem_write(sp+0x8c,struct.pack('<I',target))
   u.mem_write(sp+0x90,struct.pack('<II',0,15));u.mem_write(sp+0x9c,struct.pack('<I',3))
   u.mem_write(raw,struct.pack('<'+'H'*count,*values));u.mem_write(nibbles,bytes([initial])*count)
   for reg,value in ((UC_ARM64_REG_SP,sp),(UC_ARM64_REG_X19,ref),(UC_ARM64_REG_X21,count),(UC_ARM64_REG_X26,nibbles)):u.reg_write(reg,value)
   u.emu_start(0x247800,0x247a08,timeout=2000000,count=1000000)
   if u.reg_read(UC_ARM64_REG_PC)!=0x247a08:raise RuntimeError('native instruction bound reached')
   actual=bytes(u.mem_read(nibbles,count));expected=bytearray([initial])*count
   for i,value in enumerate(values):
    if i%264==263:continue
    d=value-target;q,remainder=divmod(abs(d),step);q=min(3,q+(remainder>=step//2))
    expected[i]=min(15,max(0,initial+(-q if d>=0 else q)))
   mismatches=sum(a!=b for a,b in zip(actual,expected))
   if mismatches:raise AssertionError((target,step,initial,mismatches))
   results.append(dict(target=target,step=step,initialNibble=initial,pixels=count,mismatches=mismatches))
report=dict(scope='MicroDM247800..247a08 isolated DDAC nibble loop',librarySha256=hashlib.sha256(lib.read_bytes()).hexdigest(),cases=results,totalPixels=sum(r['pixels']for r in results),allExact=True,limitations=['Synthetic inputs only; saved frames do not contain DDAC register-phase responses.','Step selection, valid-mean selection, packing, upload and phase readiness are outside this isolated oracle.','No device commands and no production calibration modification.'])
out=ROOT/'research/temperature-diagnosis/ddac-nibble-oracle.json';out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps(dict(cases=len(results),pixels=report['totalPixels'],allExact=True,report=str(out))))
