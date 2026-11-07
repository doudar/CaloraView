"""Research-only ARM64 reference runner; never imported by the desktop app."""
import sys, struct, pathlib, json, math, argparse, hashlib, time
import importlib.metadata
REPO=pathlib.Path(__file__).resolve().parents[2]
ROOT=REPO/'research'
sys.path.insert(0,str(ROOT/'python-deps'))
from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm64_const import *
from elftools.elf.elffile import ELFFile

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--library',type=pathlib.Path,required=True)
parser.add_argument('--calibration',type=pathlib.Path,required=True)
parser.add_argument('--metadata',type=pathlib.Path,required=True)
parser.add_argument('--width',type=int,required=True)
parser.add_argument('--height',type=int,required=True)
parser.add_argument('--ambient',type=float,required=True)
parser.add_argument('--reflected',type=float,required=True)
parser.add_argument('--humidity',type=float,required=True)
parser.add_argument('--distance',type=float,required=True)
parser.add_argument('--emissivity',type=float,required=True)
parser.add_argument('--gray',type=int,nargs='+',required=True)
parser.add_argument('--calculator',choices=('int','float-online'),default='int',help='Use the calibration-selected native family; float-online uses MT_*_OL')
parser.add_argument('--benchmark',type=int,default=0,help='Repeated point count in one native call (up to49152)')
parser.add_argument('--verbose',action='store_true')
args=parser.parse_args()
LIB=args.library
calibration_bytes=args.calibration.read_bytes()
metadata_bytes=args.metadata.read_bytes()
if not 32<=args.width<=1024 or not 32<=args.height<=1024:parser.error('Dimensions must be32..1024')
if len(calibration_bytes)!=0x3800 or struct.unpack_from('<I',calibration_bytes,4)[0]!=0x3800:parser.error('Expected exact0x3800 calibration structure')
if len(metadata_bytes)!=args.width*4:parser.error('Expected exactly two compact metadata rows')
if any(not 0<=v<=16383 for v in args.gray):parser.error('Gray values must be14-bit corrected counts')
for key in ('ambient','reflected','humidity','distance','emissivity'):
    value=getattr(args,key)
    scaled=value*8192
    if not math.isfinite(value) or not math.isfinite(scaled) or not -0x80000000<=round(scaled)<=0x7fffffff:parser.error(f'{key} must be finite and fit signed32 Q13')
if not .01<=args.emissivity<=1 or not 0<=args.humidity<=100 or args.distance<=0:parser.error('Invalid environmental settings')
if not 0<=args.benchmark<=49152:parser.error('Benchmark count must be0..49152')
type_product=(struct.unpack_from('<i',calibration_bytes,0x2b10)[0]*30+0x80000000)%0x100000000-0x80000000
integer_path=(type_product if type_product==-0x80000000 else abs(type_product))>10
if (args.calculator=='int')!=integer_path:parser.error('Calculator does not match calibration type discriminator; do not substitute another camera calibration')
if args.calculator=='float-online' and any(abs(round(getattr(args,k)*scale))>0x7fffffff for k,scale in (('ambient',1000),('reflected',1000),('humidity',1000),('distance',1000000))):parser.error('Float-online settings exceed native signed32 configuration bounds')
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
    elif name=='sqrtf':
        av=struct.unpack('<f',struct.pack('<I',u.reg_read(UC_ARM64_REG_S0)))[0]
        u.reg_write(UC_ARM64_REG_S0,struct.unpack('<I',struct.pack('<f',math.sqrt(av)))[0]);result=a
    elif name=='lround':
        av=struct.unpack('<d',struct.pack('<Q',u.reg_read(UC_ARM64_REG_D0)))[0]
        result=math.floor(av+.5) if av>=0 else math.ceil(av-.5)
    elif name in ('exp','log','sqrt','pow','ldexp'):
        av=struct.unpack('<d',struct.pack('<Q',u.reg_read(UC_ARM64_REG_D0)))[0]
        bv=struct.unpack('<d',struct.pack('<Q',u.reg_read(UC_ARM64_REG_D1)))[0]
        rv=math.ldexp(av,a if a<0x80000000 else a-0x100000000) if name=='ldexp' else (getattr(math,name)(av,bv) if name=='pow' else getattr(math,name)(av))
        u.reg_write(UC_ARM64_REG_D0,struct.unpack('<Q',struct.pack('<d',rv))[0]);result=a
    elif name=='__stack_chk_fail':raise RuntimeError('Stack check failed')
    else:raise RuntimeError(('unsupported import',name,args))
    u.reg_write(UC_ARM64_REG_X0,result&0xffffffffffffffff)
    u.reg_write(UC_ARM64_REG_PC,u.reg_read(UC_ARM64_REG_LR))
# Only imported functions need Python callbacks. Hooking every emulated ARM
# instruction obscures native execution performance without changing results.
u.hook_add(UC_HOOK_CODE,hook,begin=0x4002000,end=next_stub-1)

def call(name,*args):
    u.reg_write(UC_ARM64_REG_SP,0x30ff000)
    u.reg_write(UC_ARM64_REG_LR,sentinel)
    for i,value in enumerate(args):u.reg_write(UC_ARM64_REG_X0+i,value)
    try:u.emu_start(symbols[name],sentinel,count=1000000000)
    except Exception as e:raise RuntimeError(f'{name} PC={u.reg_read(UC_ARM64_REG_PC):x}: {e}') from e
    if u.reg_read(UC_ARM64_REG_PC)!=sentinel:raise RuntimeError('Instruction limit')
    result=u.reg_read(UC_ARM64_REG_X0)&0xffffffff
    return result if result<0x80000000 else result-0x100000000

if __name__=='__main__':
    report={'researchOnly':True,'sceneAccuracyValidated':False,'calculator':args.calculator,'runnerSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
            'pythonVersion':sys.version,'dependencies':{name:importlib.metadata.version(name) for name in ('unicorn','pyelftools')},
            'nativeLibrarySha256':hashlib.sha256(LIB.read_bytes()).hexdigest(),
            'calibrationSha256':hashlib.sha256(calibration_bytes).hexdigest(),
            'metadataSha256':hashlib.sha256(metadata_bytes).hexdigest(),
            'dimensions':[args.width,args.height],
            'environment':{k:getattr(args,k) for k in ('ambient','reflected','humidity','distance','emissivity')},
            'environmentQ13':{k:round(getattr(args,k)*8192) for k in ('ambient','reflected','humidity','distance','emissivity')},
            'inputRounding':'Python nearest integer, ties to even; not claimed identical to MicroTA caller rounding',
            'initialization':[],'points':[]}
    def checked(name,*values):
        if args.calculator=='float-online':name=name.replace('_INT','_OL') if name in ('MT_GetMemSize_INT','MT_Create_INT','MT_SetConfig_INT') else name.replace('_INT','')
        code=call(name,*values);report['initialization'].append({'call':name,'status':code})
        if code:raise RuntimeError(f'{name} returned {code}; no temperatures accepted')
    ability=alloc(struct.pack('<IIII',args.width,args.height,0,0))
    memtab=alloc(48)
    checked('MT_GetMemSize_INT',ability,memtab)
    persist=alloc(u32(memtab+8));scratch=alloc(u32(memtab+32))
    u.mem_write(memtab,struct.pack('<Q',persist));u.mem_write(memtab+24,struct.pack('<Q',scratch))
    out=alloc(8)
    checked('MT_Create_INT',ability,memtab,out)
    handle=u64(out)
    calib=alloc(calibration_bytes)
    checked('MT_SetCalibParam_INT',handle,calib)
    config_scale=8192 if args.calculator=='int' else 1000
    distance_scale=8192 if args.calculator=='int' else 1000000
    report['configurationEncoding']={'ambient':round(args.ambient*config_scale),'humidity':round(args.humidity*config_scale),'distance':round(args.distance*distance_scale),'scale':config_scale,'distanceScale':distance_scale}
    for key,value in ((5,round(args.ambient*config_scale)),(6,round(args.humidity*config_scale)),(7,round(args.distance*distance_scale)),(13,0),(15,u32(calib+8)),(29,0),(35,1 if args.verbose else 6)):
        param=alloc(struct.pack('<ii',key,value))
        checked('MT_SetConfig_INT',handle,1,param,8)
        report['initialization'][-1].update({'key':key,'value':value})
    addl=alloc(metadata_bytes)
    checked('MT_SetAddlParam_INT',handle,addl)
    if args.calculator=='float-online':
        report.pop('environmentQ13')
        report['pointEncoding']={'temperature':'float32','emissivity':'float32 fraction','reflected':'float32 Celsius','distance':'float32 millimeters','recordBytes':36}
        def point(gray):return struct.pack('<IIIIffffi',0,gray,0,0,0,args.emissivity,args.reflected,args.distance*1000,0)
        process_name='MT_Process_OL';record_size=36
    else:
        def point(gray):return struct.pack('<IIIIIH2xii',0,gray,0,0,0,round(args.emissivity*8192),round(args.reflected*8192),round(args.distance*8192))
        process_name='MT_Process_INT';record_size=32
    request=alloc(record_size)
    start=time.perf_counter()
    for gray in args.gray:
        u.mem_write(request,point(gray))
        ret=call(process_name,handle,0,request,1)
        status=s32(request)
        value=(s32(request+16)/64 if args.calculator=='int' else struct.unpack('<f',rd(request+16,4))[0]) if ret==0 and status==0 else None
        if value is not None and not math.isfinite(value):raise ValueError('Native output was non-finite despite success status')
        report['points'].append({'gray':gray,'callStatus':ret,'pointStatus':status,'q6':s32(request+16) if ret==0 and status==0 and args.calculator=='int' else None,'celsius':value})
    report['pointQuerySeconds']=time.perf_counter()-start
    report['pointResultsSha256']=hashlib.sha256(json.dumps(report['points'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
    if args.benchmark:
        batch=alloc(b''.join(point(args.gray[i%len(args.gray)]) for i in range(args.benchmark)))
        start=time.perf_counter();ret=call(process_name,handle,0,batch,args.benchmark);elapsed=time.perf_counter()-start
        statuses=[s32(batch+i*record_size) for i in range(args.benchmark)]
        report['benchmark']={'points':args.benchmark,'callStatus':ret,'failedPoints':sum(s!=0 for s in statuses),'seconds':elapsed,'projected49152Seconds':elapsed*49152/args.benchmark}
    print(json.dumps(report,indent=2))
