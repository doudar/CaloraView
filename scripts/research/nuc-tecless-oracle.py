"""Research-only synthetic TECLESS30 arithmetic oracle. No camera data or USB access."""
import sys,struct,pathlib,math,json,random,hashlib
ROOT=pathlib.Path(__file__).resolve().parents[2]/'research'
sys.path.insert(0,str(ROOT/'python-deps'))
from unicorn import Uc,UC_ARCH_ARM64,UC_MODE_ARM,UC_HOOK_CODE
from unicorn.arm64_const import *
from elftools.elf.elffile import ELFFile
LIB=ROOT/'decompiled/resources/lib/arm64-v8a/libifrnuc.so'
if hashlib.sha256(LIB.read_bytes()).hexdigest()!='98845496b8e3a3f4a0462464434c2a65ece657937d3793de61650822becc9c27':
    raise ValueError('This oracle is bounded to the inspected APK library build')
u=Uc(UC_ARCH_ARM64,UC_MODE_ARM)
u.mem_map(0,0x100000)
u.mem_map(0x1000000,0x1000000)
u.mem_map(0x3000000,0x100000)
u.mem_map(0x4000000,0x10000)
u.reg_write(UC_ARM64_REG_CPACR_EL1,3<<20)
u.reg_write(UC_ARM64_REG_TPIDR_EL0,0x4000000)
sentinel=0x4001000
u.mem_write(sentinel,b'\xc0\x03\x5f\xd6')
symbols={}; external={}; next_stub=0x4002000; heap=0x1000000

def alloc(data_or_size):
    global heap
    requested=data_or_size if isinstance(data_or_size,int) else len(data_or_size)
    if requested<0 or requested>0x1000000 or ((heap+127)&~127)+requested>0x2000000:raise MemoryError('Research allocation exceeds heap bounds')
    data=bytes(data_or_size) if isinstance(data_or_size,int) else bytes(data_or_size)
    heap=(heap+127)&~127
    if heap+len(data)>0x2000000:raise MemoryError('Research heap exhausted')
    p=heap;heap+=(len(data)+127)&~127;u.mem_write(p,data);return p
def rd(p,n):return bytes(u.mem_read(p,n))
def u32(p):return struct.unpack('<I',rd(p,4))[0]
def s32(p):return struct.unpack('<i',rd(p,4))[0]
def u64(p):return struct.unpack('<Q',rd(p,8))[0]
def cstr(p):
    b=bytearray()
    while rd(p+len(b),1)!=b'\0':
        if len(b)>=4096:raise ValueError('Native string exceeds research limit')
        b+=rd(p+len(b),1)
    return bytes(b)

with LIB.open('rb') as f:
    elf=ELFFile(f)
    if elf.elfclass!=64 or not elf.little_endian or elf['e_machine']!='EM_AARCH64':raise ValueError('Expected little-endian ARM64 ELF')
    for seg in elf.iter_segments():
        if seg['p_type']=='PT_LOAD':
            if seg['p_vaddr']+seg['p_memsz']>0x100000 or seg['p_filesz']>seg['p_memsz']:raise ValueError('ELF segment exceeds research image mapping')
            u.mem_write(seg['p_vaddr'],seg.data())
    symtab=elf.get_section_by_name('.dynsym')
    for sym in symtab.iter_symbols():
        if sym['st_value']:symbols[sym.name]=sym['st_value']
    for name in ('.rela.dyn','.rela.plt'):
        section=elf.get_section_by_name(name)
        if not section:continue
        for r in section.iter_relocations():
            add=r['r_addend'];typ=r['r_info_type'];p=r['r_offset']
            if not 0<=p<=0x100000-8:raise ValueError('Relocation outside image')
            if typ==1027:value=add
            elif typ in (257,1025,1026):
                sym=symtab.get_symbol(r['r_info_sym'])
                value=sym['st_value']
                if not value:
                    if next_stub>=0x4010000:raise MemoryError('Too many external symbols')
                    value=next_stub;next_stub+=4;external[value]=sym.name
                    u.mem_write(value,b'\xc0\x03\x5f\xd6')
                value+=add
            else:raise RuntimeError(('relocation',typ))
            u.mem_write(p,struct.pack('<Q',value))

def hook(uc,address,size,user):
    if address not in external:return
    name=external[address]
    args=[u.reg_read(UC_ARM64_REG_X0+i) for i in range(4)]
    a,b,c,d=args
    if name in ('memcpy','memmove','__memcpy_chk','memset','__memset_chk','memcmp') and c>0x1000000:raise MemoryError('Native memory operation exceeds research limit')
    if name in ('memcpy','memmove','__memcpy_chk'):u.mem_write(a,rd(b,c));result=a
    elif name in ('memset','__memset_chk'):u.mem_write(a,bytes([b&255])*c);result=a
    elif name=='strlen':result=len(cstr(a))
    elif name=='strcmp':result=(cstr(a)>cstr(b))-(cstr(a)<cstr(b))
    elif name=='memcmp':result=(rd(a,c)>rd(b,c))-(rd(a,c)<rd(b,c))
    elif name in ('printf','puts','__android_log_print'):
        if '--verbose' in sys.argv: print('NATIVE',cstr(c if name=='__android_log_print' else a).decode(errors='replace').strip(),args[1:], [struct.unpack('<d',struct.pack('<Q',u.reg_read(UC_ARM64_REG_D0+i)))[0] for i in range(2)],file=sys.stderr)
        result=0
    elif name in ('exp','log','sqrt','pow','ldexp'):
        av=struct.unpack('<d',struct.pack('<Q',u.reg_read(UC_ARM64_REG_D0)))[0]
        bv=struct.unpack('<d',struct.pack('<Q',u.reg_read(UC_ARM64_REG_D1)))[0]
        rv=math.ldexp(av,a if a<0x80000000 else a-0x100000000) if name=='ldexp' else (getattr(math,name)(av,bv) if name=='pow' else getattr(math,name)(av))
        u.reg_write(UC_ARM64_REG_D0,struct.unpack('<Q',struct.pack('<d',rv))[0]);result=a
    elif name=='__stack_chk_fail':raise RuntimeError('Stack check failed')
    else:raise RuntimeError(('unsupported import',name,args))
    u.reg_write(UC_ARM64_REG_X0,result&0xffffffffffffffff)
    u.reg_write(UC_ARM64_REG_PC,u.reg_read(UC_ARM64_REG_LR))
u.hook_add(UC_HOOK_CODE,hook)

def call(name,*args):
    u.reg_write(UC_ARM64_REG_SP,0x30ff000)
    u.reg_write(UC_ARM64_REG_LR,sentinel)
    for i,value in enumerate(args):
        if i<8:u.reg_write(UC_ARM64_REG_X0+i,value)
        else:u.mem_write(0x30ff000+8*(i-8),struct.pack('<Q',value))
    try:u.emu_start(symbols[name],sentinel,count=1000000000)
    except Exception as e:raise RuntimeError(f'{name} PC={u.reg_read(UC_ARM64_REG_PC):x}: {e}') from e
    if u.reg_read(UC_ARM64_REG_PC)!=sentinel:raise RuntimeError('Instruction limit')
    result=u.reg_read(UC_ARM64_REG_X0)&0xffffffff
    return result if result<0x80000000 else result-0x100000000

def s16(v):return (v+32768)%65536-32768
def i32(v):return (v+2147483648)%4294967296-2147483648
def formula(raw,gain,background,drift,delta,mean_drift,background_drift,offset,global_on=True):
    global_term=s16((i32(delta*(mean_drift-background_drift))&0xffffffff)>>11) if global_on else 0
    term=((raw<<13)-(background<<11)-i32((delta<<2)*drift))*gain
    return max(0,min(16383,offset+global_term+(term>>28)))

random.seed(20261107)
cases=[]
for case in range(35):
    count=17
    raw=[random.randrange(65536) for _ in range(count)]
    gain=[random.randrange(65536) for _ in range(count)]
    background=[random.randrange(65536) for _ in range(count)]
    drift=[random.randrange(-32768,32768) for _ in range(count)]
    sensor=random.randrange(-32768,32768);baseline=random.randrange(-32768,32768)
    mean_drift=random.randrange(-32768,32768);background_drift=random.randrange(-32768,32768)
    offset=random.randrange(65536);global_on=case%2==0
    handle=alloc(0x800);hist=alloc(64);scratch=alloc(64)
    rawp=alloc(struct.pack('<'+'H'*count,*raw));gainp=alloc(struct.pack('<'+'H'*count,*gain));bgp=alloc(struct.pack('<'+'H'*count,*background));driftp=alloc(struct.pack('<'+'h'*count,*drift))
    outputs=[alloc(8) for _ in range(4)]
    def wr(off,fmt,value):u.mem_write(handle+off,struct.pack('<'+fmt,value))
    wr(6,'H',17);wr(0xc,'I',count);wr(0xde,'H',offset);wr(0xec,'B',1);wr(0xf0,'B',1);wr(0x111,'B',0 if global_on else 1)
    wr(0x140,'Q',scratch);wr(0x150,'Q',hist);wr(0x610,'B',1);wr(0x611,'B',1);wr(0x668,'Q',driftp)
    wr(0x68a,'h',mean_drift);wr(0x68c,'h',background_drift);wr(0x69c,'h',baseline)
    status=call('NUC_TECLESS30_Process',handle,rawp,gainp,bgp,sensor&0xffffffff,*outputs)
    got=list(struct.unpack('<'+'H'*count,rd(rawp,count*2)))
    expected=[formula(r,k,b,d,sensor-baseline,mean_drift,background_drift,offset,global_on) for r,k,b,d in zip(raw,gain,background,drift)]
    if status!=0 or got!=expected:raise AssertionError((case,status,got,expected))
    cases.append({'raw':raw,'gain':gain,'background':background,'drift':drift,'sensorDelta':sensor-baseline,'meanDrift':mean_drift,'backgroundDrift':background_drift,'offset':offset,'globalCompensation':global_on,'expected':got})
print(json.dumps({'librarySha256':hashlib.sha256(LIB.read_bytes()).hexdigest(),'cases':len(cases),'pixels':len(cases)*17,'allMatched':True},indent=2))
(ROOT/'nuc-tecless-synthetic-vectors.json').write_text(json.dumps(cases,indent=2))
