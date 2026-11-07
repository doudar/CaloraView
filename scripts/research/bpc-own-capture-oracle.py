"""Native isolatedBPC comparison on owned scene capture with actual factoryBPM."""
import pathlib,struct,subprocess,hashlib,json
ROOT=pathlib.Path(__file__).resolve().parents[2]
loader=ROOT/'scripts/research/bpc-isolated-oracle.py'
prefix,sep,_=loader.read_text().partition('rng = random.Random')
assert sep
v={'__file__':str(loader)};exec(compile(prefix,str(loader),'exec'),v)
u,alloc,rd,call=v['u'],v['alloc'],v['rd'],v['call'];h=v['handle']
def put(off,fmt,value):u.mem_write(h+off,struct.pack('<'+fmt,value))
put(6,'H',256);put(8,'H',192);put(0xc,'I',49152);put(0x468,'Q',alloc(49152));put(0x408,'Q',alloc(struct.pack('<2H',1,78)));put(0x410,'Q',alloc(struct.pack('<2H',171,14)))
raw=(ROOT/'test-output/ui/2026-11-07T16-43-56-093Z-recording-LXSjMG/sensor.raw').read_bytes();cases=[]
js="const fs=require('fs'),{parseBadPixels,correctIsolatedBadPixels}=require('./src/core/bad-pixels.cjs');const b=fs.readFileSync(0),a=new Uint16Array(49152);for(let i=0;i<a.length;i++)a[i]=b.readUInt16LE(i*2);let p=parseBadPixels(fs.readFileSync('research/sk02-device-export-20261107/files/BPM.bin'));process.stdout.write(Buffer.from(correctIsolatedBadPixels(a,p).buffer));"
for index in (0,10,20,30,44):
 frame=raw[index*117216:(index+1)*117216];values=[struct.unpack_from('<H',frame,((y+2)*264+x+4)*2)[0] for y in range(192) for x in range(256)];b=struct.pack('<49152H',*values);image=alloc(b);assert call('NUC_BPC_DoBPCompensationByMask',h,image)==0;native=rd(image,98304);got=subprocess.run(['node','-e',js],input=b,cwd=ROOT,capture_output=True,check=True).stdout;assert got==native;cases.append(dict(frame=index,sha256=hashlib.sha256(native).hexdigest()))
report=dict(allMatched=True,pixels=len(cases)*49152,cases=cases);(ROOT/'research/bpc-own-capture-reference.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
