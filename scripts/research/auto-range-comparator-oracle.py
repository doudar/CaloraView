"""Bounded synthetic native auto-range comparator oracle. No camera access."""
import sys, pathlib, struct, hashlib, json
ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'research/python-deps'))
from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm64_const import *
from elftools.elf.elffile import ELFFile
lib=ROOT/'research/decompiled/resources/lib/arm64-v8a/libMicroRVP_Release_v8a.so'
u=Uc(UC_ARCH_ARM64,UC_MODE_ARM)
u.mem_map(0,0x400000);u.mem_map(0x1000000,0x100000);u.mem_map(0x3000000,0x100000);u.mem_map(0x4000000,0x10000)
u.reg_write(UC_ARM64_REG_TPIDR_EL0,0x4000000);u.reg_write(UC_ARM64_REG_CPACR_EL1,3<<20)
with lib.open('rb') as fh:
 e=ELFFile(fh)
 assert e.elfclass==64 and e['e_machine']=='EM_AARCH64'
 for seg in e.iter_segments():
  if seg['p_type']=='PT_LOAD':
   assert seg['p_vaddr']+seg['p_memsz']<0x400000
   u.mem_write(seg['p_vaddr'],seg.data())
heap=0x1000000

def alloc(data):
 global heap
 if isinstance(data,int):data=bytes(data)
 at=heap;heap=(heap+len(data)+127)&~127
 assert heap<0x1100000
 u.mem_write(at,data);return at

def put(p,fmt,*values):u.mem_write(p,struct.pack(fmt,*values))
def rd(p,fmt):return struct.unpack(fmt,bytes(u.mem_read(p,struct.calcsize(fmt))))[0]
sentinel=0x4001000;callback=0x4002000
calls=[]
def hook(uc,pc,size,user):
 if pc in (0x1a6a00,0x1a6a60,callback):
  if pc==callback:calls.append(rd(uc.reg_read(UC_ARM64_REG_X1),'<B'))
  uc.reg_write(UC_ARM64_REG_X0,1);uc.reg_write(UC_ARM64_REG_PC,uc.reg_read(UC_ARM64_REG_LR))
 elif pc in (0x1a6810,0x12b990):raise RuntimeError('Native guard failed')
u.hook_add(UC_HOOK_CODE,hook)
transitions=[(1,2,0,150),(1,3,1,65),(2,3,1,65),(2,1,1,130),(3,2,0,150),(3,1,0,70)]
records=alloc(b''.join(struct.pack('<BB2xii',a,b,op,t*8192) for a,b,op,t in transitions))
profile=alloc(64);nodes=[alloc(48) for _ in range(3)]
for i,n in enumerate(nodes):
 put(n+8,'<Q',nodes[i+1] if i<2 else 0);put(n+28,'<B',i+1);put(n+32,'<B',i+1)
put(profile+16,'<QQQ',nodes[0],nodes[0],3);put(profile+40,'<QQQ',records,records+72,records+72)
current=alloc(12);stats=alloc(224);vector=alloc(struct.pack('<QQQ',stats,stats+224,stats+224));now=alloc(8);last=alloc(8);mutex=alloc(48)
vt=alloc(64);put(vt+48,'<Q',callback);obj=alloc(struct.pack('<Q',vt));fn=alloc(40);put(fn+32,'<Q',obj)
out_range=alloc(12);out_value=alloc(4)

def run(gear,maxima,averages,mode=0,elapsed=1500000000,enabled=True):
 calls.clear();put(profile,'<B3xII',enabled,1500,mode);put(current,'<B',gear)
 put(last,'<Q',0);put(now,'<Q',elapsed)
 for i,(mx,avg) in enumerate(zip(maxima,averages)):
  put(stats+i*112+12,'<i',mx);put(stats+i*112+76,'<i',avg)
 put(out_range,'<I',0);put(out_value,'<i',0)
 args=[profile,current,vector,now,mutex,last,0,fn,out_range,out_value]
 sp=0x30ff000
 u.reg_write(UC_ARM64_REG_SP,sp);u.reg_write(UC_ARM64_REG_LR,sentinel)
 for i,v in enumerate(args):
  if i<8:u.reg_write(UC_ARM64_REG_X0+i,v)
  else:put(sp+(i-8)*8,'<Q',v)
 u.emu_start(0x12b620,sentinel,count=20000)
 assert u.reg_read(UC_ARM64_REG_PC)==sentinel
 value=max(averages if mode==1 else maxima);expected=None
 if enabled and elapsed>=1500000000:
  for src,dst,op,t in transitions:
   if src==gear and ((op==0 and value>t*8192) or (op==1 and value<t*8192)):
    expected=dst;break
 actual=calls[0] if calls else None
 assert expected==actual,(gear,maxima,averages,mode,elapsed,expected,actual)
 assert bool(u.reg_read(UC_ARM64_REG_X0))==(expected is not None)
 if expected is not None:assert rd(out_value,'<i')==value and rd(out_range,'<B')==expected
 return dict(gear=gear,maximaQ13=maxima,averagesQ13=averages,mode=mode,elapsedNs=elapsed,enabled=enabled,destination=actual)
cases=[]
for gear in (1,2,3):
 for value in (20*8192,65*8192-1,65*8192,65*8192+1,70*8192-1,70*8192,70*8192+1,130*8192-1,130*8192,130*8192+1,150*8192-1,150*8192,150*8192+1):
  for mode in (0,1):cases.append(run(gear,[value-50,value],[value-100,value-10],mode))
for elapsed in (0,1499999999,1500000000,1500000001):cases.append(run(3,[80*8192,90*8192],[20*8192,25*8192],elapsed=elapsed))
cases.append(run(3,[160*8192,90*8192],[20*8192,25*8192],enabled=False))
report=dict(researchOnly=True,librarySha256=hashlib.sha256(lib.read_bytes()).hexdigest(),nativeEntry='0x12b620',cases=len(cases),errors=0,results=cases)
out=ROOT/'research/temperature-diagnosis/auto-range-comparator-oracle.json';out.write_text(json.dumps(report,indent=2));print(json.dumps(dict(cases=len(cases),errors=0,output=str(out))))
