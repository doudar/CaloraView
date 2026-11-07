"""Export and validate scalar-input/output Real-ESRGAN DN50 for a 2x display."""
import pathlib,sys,json,hashlib,time
ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'research/neural-sr/real-deps'),str(ROOT/'research/neural-sr/fsrcnn-deps')]
import numpy as np
import torch
import onnx,onnxruntime as ort
from PIL import Image,ImageDraw
folder=ROOT/'research/neural-sr/real-models';out=ROOT/'research/neural-sr/real-output'
source=(folder/'srvgg_arch.py').read_text()
assert hashlib.sha256(source.encode()).hexdigest()=='7419a75e789ca09295266563d74a6d7c08d6c24502af6b0a919b1811d0a0be59'
namespace={};exec(source.replace('from basicsr.utils.registry import ARCH_REGISTRY','').replace('@ARCH_REGISTRY.register()',''),namespace)
model=namespace['SRVGGNetCompact'](num_in_ch=3,num_out_ch=3,num_feat=64,num_conv=32,upscale=4,act_type='prelu').eval()
weights=[]
for name,digest in [('realesr-general-x4v3.pth','8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292'),('realesr-general-wdn-x4v3.pth','1641f8c4464b9f097c9fdda5589273713f67cf59f3d909e0bd688f0cee269dca')]:
 file=folder/name;assert hashlib.sha256(file.read_bytes()).hexdigest()==digest
 state=torch.load(file,map_location='cpu',weights_only=True);weights.append(state.get('params_ema',state.get('params',state)))
model.load_state_dict({k:(weights[0][k]+weights[1][k])*.5 for k in weights[0]},strict=True)
class GrayDisplay(torch.nn.Module):
 def __init__(self,core):super().__init__();self.core=core
 def forward(self,x):
  rgb=self.core(x.repeat(1,3,1,1))
  gray=torch.clamp(rgb.mean(dim=1,keepdim=True),0,1)
  return torch.nn.functional.avg_pool2d(gray,2,2)
wrapped=GrayDisplay(model).eval();torch.set_num_threads(4)
file=folder/'real-general-dn50-gray2x.onnx'
with torch.inference_mode():torch.onnx.export(wrapped,torch.zeros(1,1,192,256),str(file),input_names=['input'],output_names=['output'],opset_version=17,dynamo=False)
onnx.checker.check_model(str(file))
frames=sorted((ROOT/'research/neural-sr/real-input').glob('frame-*.pgm'))
inputs=[np.array(Image.open(f),dtype=np.float32)[None,None]/255 for f in frames]
report={'researchOnly':True,'model':str(file),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'bytes':file.stat().st_size,'input':[1,1,192,256],'output':[1,1,384,512],'source':'https://github.com/xinntao/Real-ESRGAN','license':'BSD-3-Clause','denoiseStrength':.5,'grayTransform':'repeat scalar to RGB; channel mean; clamp0..1; area2 average pooling after4x inference','normalization':'production1..99percentile quantized8bit reference frames','torch':torch.__version__,'onnx':onnx.__version__,'ort':ort.__version__}
def session(provider):
 opts=ort.SessionOptions();opts.enable_mem_pattern=False;opts.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL;opts.intra_op_num_threads=4
 return ort.InferenceSession(str(file),sess_options=opts,providers=provider)
cpu=session(['CPUExecutionProvider']);gpu=session([('DmlExecutionProvider',{'device_id':0}),'CPUExecutionProvider'])
validation=[]
for name,tensor in [('actual',inputs[0]),('ramp',np.linspace(0,1,49152,dtype=np.float32).reshape(1,1,192,256)),('uniform',np.full((1,1,192,256),.5,dtype=np.float32))]:
 with torch.inference_mode():expected=wrapped(torch.from_numpy(tensor)).numpy()
 c=cpu.run(None,{'input':tensor})[0];g=gpu.run(None,{'input':tensor})[0]
 cmax=float(np.max(abs(c-expected)));gmax=float(np.max(abs(g-expected)))
 assert cmax<.0001,(name,cmax)
 assert gmax<.015,(name,gmax)
 validation.append({'input':name,'cpuMaxAbsError':cmax,'dmlMaxAbsError':gmax,'dmlMeanAbsError':float(np.mean(abs(g-expected)))})
report['validation']=validation
times=[];outputs=[]
for tensor in inputs:
 start=time.perf_counter();result=gpu.run(None,{'input':tensor})[0];times.append((time.perf_counter()-start)*1000);outputs.append(result[0,0])
report['gpu']={'adapter':0,'frames':len(times),'meanMs':float(np.mean(times)),'p95Ms':float(np.percentile(times,95)),'maxMs':max(times),'timesMs':times}
for idx in (0,10,20,30,44):Image.fromarray(np.uint8(np.rint(outputs[idx]*255))).save(out/f'dn50-gray2x-{frames[idx].stem}.png')
sheet=Image.new('RGB',(1536,414));draw=ImageDraw.Draw(sheet)
native=Image.open(frames[0]);images=[native.resize((512,384),Image.Resampling.BICUBIC),Image.open(out/'dn50-dml0-frame-000.png'),Image.fromarray(np.uint8(np.rint(outputs[0]*255)))]
for i,(image,title) in enumerate(zip(images,['Bicubic2x','RealESRGAN DN50 Lanczos2x','RealESRGAN DN50 scalar area2x'])):
 sheet.paste(image,(i*512,30));draw.text((i*512+8,8),title,fill='white')
sheet.save(out/'gray2x-comparison.png')
(out/'benchmark-gray2x.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
