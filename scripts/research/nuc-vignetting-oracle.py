"""Offline synthetic VC template, alpha and pixel comparison against the inspected native branch."""
import pathlib,struct,json,subprocess,hashlib,argparse
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--matrix',type=pathlib.Path);args=p.parse_args()
actual=args.matrix.read_bytes() if args.matrix else None
if actual is not None and len(actual)!=98304:raise ValueError('Expected exact256x192 signed16 VC matrix')
source=pathlib.Path(__file__).with_name('nuc-downstream-oracle.py')
prefix,sep,_=source.read_text().partition('# Compare production JS')
if not sep:raise RuntimeError('Downstream loader boundary changed')
v={'__file__':str(source),'__name__':'vc_loader'};exec(compile(prefix,str(source),'exec'),v)
u,alloc,call,rd,handle,root=[v[n] for n in ('u','alloc','call','rd','handle','root')]
def get(offset,fmt):return struct.unpack('<'+fmt,rd(handle+offset,struct.calcsize(fmt)))[0]
# Enable the SetMatrix software-copy gate explicitly; no device calls.
u.mem_write(handle+0x26,bytes([rd(handle+0x26,1)[0]|4]))
results=[]
for kind in range(7 if actual is not None else 6):
 values=[]
 for y in range(192):
  for x in range(256):
   if kind==0:val=0
   elif kind==1:val=(x//16)*11-(y//16)*7-80
   elif kind==2:val=((x*7+y*19)%801)-400
   elif kind==3:val=-32768 if (x//16)%2 else 32767
   elif kind==4:val=(x-128)*(x-128)//10+(y-96)*(y-96)//10-900
   elif kind==5:val=-1
   else:val=struct.unpack_from('<h',actual,2*(y*256+x))[0]
   values.append(val)
 matrix=struct.pack('<49152h',*values);mp=alloc(matrix)
 u.mem_write(handle+0x528,struct.pack('<q',0))
 assert call('IFR_NUC_Cali_VignettingCorrection_SetMatrix',handle,mp)==0
 matrix_state={'threshold':get(0x51a,'H'),'denominator':str(get(0x530,'q')),'gradients':list(struct.unpack('<192h',rd(get(0x548,'Q'),384)))}
 frames=[];native=[]
 for frame in range(5):
  image=[]
  for i,value in enumerate(values):
   x=i%256;y=i//256
   if frame==0:pixel=6000+value//8
   elif frame==1:pixel=6000-value//4+(x%5)
   elif frame==2:pixel=(x*29+y*43)%16384
   elif frame==3:pixel=(x+y)%9
   else:pixel=16375+(x+y)%9
   image.append(max(0,min(65535,pixel)))
  raw=struct.pack('<49152H',*image);ip=alloc(raw);op=alloc(len(raw))
  assert call('NUC_VignettingCorrection_Process',handle,ip,op)==0
  frames.append(image);native.append({'alpha':get(0x528,'q'),'sha256':hashlib.sha256(rd(op,len(raw))).hexdigest()})
 js="const fs=require('fs'),crypto=require('crypto');const {VignettingCorrection}=require('./src/core/nuc-vignetting.cjs');const q=JSON.parse(fs.readFileSync(0));const vc=new VignettingCorrection(Int16Array.from(q.map));const state={threshold:vc.threshold,denominator:String(vc.denominator),gradients:Array.from(vc.gradients)};const frames=q.frames.map(a=>{const r=vc.process(Uint16Array.from(a));return {alpha:r.alpha,sha256:crypto.createHash('sha256').update(Buffer.from(r.corrected.buffer)).digest('hex')}});console.log(JSON.stringify({state,frames}));"
 result=json.loads(subprocess.run(['node','-e',js],input=json.dumps({'map':values,'frames':frames}),text=True,cwd=root,capture_output=True,check=True).stdout)
 if result['state']!=matrix_state:raise AssertionError(('template',kind,result['state'],matrix_state))
 if result['frames']!=native:raise AssertionError(('frames',kind,result['frames'],native))
 results.append({'map':kind,'templateExact':True,'frames':native})
report={'researchOnly':True,'allMatched':True,'maps':len(results),'frames':sum(len(r['frames']) for r in results),'pixels':49152*sum(len(r['frames']) for r in results),'results':results}
report['actualMapSha256']=hashlib.sha256(actual).hexdigest() if actual is not None else None
(root/('research/nuc-vignetting-reference-actual.json' if actual is not None else 'research/nuc-vignetting-reference.json')).write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='results'}))
