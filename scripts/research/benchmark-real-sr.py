"""Offline Real-ESRGAN compact export/benchmark. Official BSD-3 source/weights stay in research."""
import pathlib, sys, json, hashlib, time, argparse
ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'research/neural-sr/real-deps'),str(ROOT/'research/neural-sr/fsrcnn-deps')]
import numpy as np
import torch
from PIL import Image,ImageDraw
import onnxruntime as ort

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--export-only',action='store_true')
p.add_argument('--adapter',type=int,default=0)
p.add_argument('--cpu',action='store_true')
p.add_argument('--frames',type=int,default=5)
args=p.parse_args()
folder=ROOT/'research/neural-sr/real-models'
out=ROOT/'research/neural-sr/real-output';out.mkdir(exist_ok=True)
# Execute only the inspected official architecture definition; omit BasicSR's
# registry import/decorator, which has no effect on forward arithmetic.
source=(folder/'srvgg_arch.py').read_text()
if hashlib.sha256(source.encode()).hexdigest()!='7419a75e789ca09295266563d74a6d7c08d6c24502af6b0a919b1811d0a0be59':
 raise ValueError('Architecture source hash differs')
source=source.replace('from basicsr.utils.registry import ARCH_REGISTRY','').replace('@ARCH_REGISTRY.register()','')
namespace={};exec(compile(source,str(folder/'srvgg_arch.py'),'exec'),namespace)
model=namespace['SRVGGNetCompact'](num_in_ch=3,num_out_ch=3,num_feat=64,num_conv=32,upscale=4,act_type='prelu').eval()
strong=torch.load(folder/'realesr-general-x4v3.pth',map_location='cpu',weights_only=True)
weak=torch.load(folder/'realesr-general-wdn-x4v3.pth',map_location='cpu',weights_only=True)
strong=strong.get('params_ema',strong.get('params',strong));weak=weak.get('params_ema',weak.get('params',weak))
torch.set_num_threads(4)
sample=torch.zeros((1,3,192,256))
models=[]
for strength in (.5,1.):
 name=f'real-general-dn{int(strength*100)}.onnx';file=folder/name
 if not file.exists():
  model.load_state_dict({k:strong[k]*strength+weak[k]*(1-strength) for k in strong},strict=True)
  with torch.inference_mode():
   torch.onnx.export(model,sample,str(file),input_names=['input'],output_names=['output'],opset_version=17,dynamo=False)
 models.append((strength,file))
 print('MODEL',name,file.stat().st_size,hashlib.sha256(file.read_bytes()).hexdigest(),flush=True)
if args.export_only:sys.exit(0)
frames=sorted((ROOT/'research/neural-sr/real-input').glob('frame-*.pgm'))[:args.frames]
inputs=[np.repeat((np.array(Image.open(f),dtype=np.float32)/255)[None,None],3,axis=1) for f in frames]
report={'researchOnly':True,'torch':torch.__version__,'ort':ort.__version__,'adapter':args.adapter,'cpu':args.cpu,'frames':len(frames),'models':[]}
for strength,file in models:
 options=ort.SessionOptions();options.enable_mem_pattern=False;options.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL;options.intra_op_num_threads=4
 providers=['CPUExecutionProvider'] if args.cpu else [('DmlExecutionProvider',{'device_id':args.adapter}),'CPUExecutionProvider']
 start=time.perf_counter();session=ort.InferenceSession(str(file),sess_options=options,providers=providers);initial=(time.perf_counter()-start)*1000
 for _ in range(2):session.run(None,{'input':inputs[0]})
 times=[];outputs=[]
 for tensor in inputs:
  start=time.perf_counter();value=session.run(None,{'input':tensor})[0];times.append((time.perf_counter()-start)*1000)
  # Equal-channel input still produces small RGB differences; collapse back to
  # scalar luminance before any thermal palette, then 4x -> requested 2x.
  gray=np.clip(value[0].mean(axis=0),0,1)
  image=Image.fromarray(np.uint8(np.rint(gray*255))).resize((512,384),Image.Resampling.LANCZOS)
  outputs.append(image)
 label=f'dn{int(strength*100)}-'+('cpu' if args.cpu else f'dml{args.adapter}')
 for idx,image in enumerate(outputs):image.save(out/f'{label}-{frames[idx].stem}.png')
 record={'strength':strength,'model':str(file),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'initialMs':initial,'timesMs':times,'meanMs':float(np.mean(times)),'p95Ms':float(np.percentile(times,95)),'providers':session.get_providers()}
 report['models'].append(record);print(json.dumps(record),flush=True)
 sheet=Image.new('RGB',(1536,414));draw=ImageDraw.Draw(sheet)
 native=Image.open(frames[0]);variants=[native.resize((512,384),Image.Resampling.NEAREST),native.resize((512,384),Image.Resampling.BICUBIC),outputs[0]]
 for i,(image,title) in enumerate(zip(variants,['Native nearest','Bicubic 2x',f'Real-ESRGAN dn{strength} 4x to2x'])):
  sheet.paste(image,(i*512,30));draw.text((i*512+8,8),title,fill='white')
 sheet.save(out/f'{label}-comparison.png')
 del session
(out/('benchmark-cpu.json' if args.cpu else f'benchmark-dml{args.adapter}.json')).write_text(json.dumps(report,indent=2))
