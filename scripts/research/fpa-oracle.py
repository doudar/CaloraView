"""Bounded arithmetic-only MicroDM FPA oracle; skips logging, not math."""
import contextlib,io,runpy,pathlib,struct,json,hashlib,random
ROOT=pathlib.Path(__file__).resolve().parents[2]
with contextlib.redirect_stdout(io.StringIO()):vm=runpy.run_path(str(ROOT/'scripts/research/nuc-tecless-oracle.py'))
u,alloc,rd=vm['u'],vm['alloc'],vm['rd']
from unicorn import UC_HOOK_CODE
from unicorn.arm64_const import *
lib=ROOT/'research/decompiled/resources/lib/arm64-v8a/libMicroDM_Release_v8a.so'
# Text LOAD is at VA=fileoffset for this bounded function.
b=lib.read_bytes();assert hashlib.sha256(b).hexdigest()=='0ba93d02ddbf53916e4fea8a3f5e65e391e61afd125295c4389bed57c77903af';u.mem_map(0x280000,0x10000);u.mem_write(0x285aa8,b[0x285aa8:0x286390])
def stoplogs(uc,pc,size,user):
    if pc==0x285fe8:uc.reg_write(UC_ARM64_REG_PC,0x286050)
    elif pc==0x286068:
        uc.reg_write(UC_ARM64_REG_S0,uc.reg_read(UC_ARM64_REG_S9));uc.reg_write(UC_ARM64_REG_PC,vm['sentinel'])
u.hook_add(UC_HOOK_CODE,stoplogs)
plane=alloc(98304);arg=alloc(80)
u.mem_write(arg,struct.pack('<QIIII',plane,256,192,512,1))
def native(values):
    u.mem_write(plane,struct.pack('<49152H',*values));u.reg_write(UC_ARM64_REG_X0,arg);u.reg_write(UC_ARM64_REG_SP,0x30ff000);u.reg_write(UC_ARM64_REG_LR,vm['sentinel'])
    u.emu_start(0x285aa8,vm['sentinel'],count=100000)
    assert u.reg_read(UC_ARM64_REG_PC)==vm['sentinel']
    return struct.unpack('<f',struct.pack('<I',u.reg_read(UC_ARM64_REG_S0)))[0]
source=ROOT/'research/shutter-JEHPUQ/sensor.raw';raw=source.read_bytes();cases=[]
for index in range(len(raw)//117216):
    frame=raw[index*117216:(index+1)*117216]
    values=[struct.unpack_from('<H',frame,((y+2)*264+x+4)*2)[0] for y in range(192) for x in range(256)]
    estimate=native(values)
    cases.append(dict(index=index,samples=[values[y*256+255] for y in range(0,192,10)],estimate=estimate,word=(int(estimate)*50)&65535))
for count in [0,1,65535,8000,8500,10000]:
    values=[count]*49152;estimate=native(values)
    cases.append(dict(index='constant-'+str(count),samples=[count]*20,estimate=estimate,word=(int(estimate)*50)&65535))
output=ROOT/'research/fpa-native-vectors.json';output.write_text(json.dumps(dict(sourceSha256=hashlib.sha256(raw).hexdigest(),cases=cases),indent=2));print(json.dumps(dict(cases=len(cases),first=cases[0],output=str(output))))
