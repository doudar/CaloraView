"""Research-only FSRCNN conversion validation and bounded inference benchmark."""
from pathlib import Path
import sys,json,time,hashlib,platform,statistics
ROOT=Path(__file__).resolve().parents[2];BASE=ROOT/'research/neural-sr';sys.path.insert(0,str(BASE/'fsrcnn-deps'))
import numpy as np,cv2,onnxruntime as ort
cv2.setNumThreads(1)
# Instantiation registers OpenCV's DepthToSpace implementation for the original TF graph.
sr=cv2.dnn_superres.DnnSuperResImpl_create();net=cv2.dnn.readNetFromTensorflow(str(BASE/'fsrcnn-x2.pb'))
frames=[]
for i in [0,10,20,30,44]:
 p=BASE/f'real-input/frame-{i:03d}.pgm';a=cv2.imread(str(p),cv2.IMREAD_GRAYSCALE);assert a.shape==(192,256);frames.append((f'own-{i:03d}',a.astype(np.float32)[None,None]/255))
rng=np.random.default_rng(20261107)
frames += [('zero',np.zeros((1,1,192,256),np.float32)),('constant',np.full((1,1,192,256),.5,np.float32)),('noise',rng.random((1,1,192,256),dtype=np.float32))]
reference={}
for name,a in frames:net.setInput(a);reference[name]=net.forward().copy()
report={'displayOnly':True,'physicalOrThermalAccuracyClaim':False,'sourceModelSha256':hashlib.sha256((BASE/'fsrcnn-x2.pb').read_bytes()).hexdigest(),'onnxSha256':hashlib.sha256((BASE/'fsrcnn-x2.onnx').read_bytes()).hexdigest(),'versions':{'numpy':np.__version__,'opencv':cv2.__version__,'onnxruntime':ort.__version__},'platform':platform.platform(),'processors':[],'validation':[],'benchmarks':[]}
for provider,threads in [('CPUExecutionProvider',1),('CPUExecutionProvider',4),('DmlExecutionProvider',1)]:
 opts=ort.SessionOptions();opts.intra_op_num_threads=threads;opts.inter_op_num_threads=1;opts.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL
 if provider=='DmlExecutionProvider':opts.enable_mem_pattern=False
 begin=time.perf_counter()
 session=ort.InferenceSession(str(BASE/'fsrcnn-x2.onnx'),sess_options=opts,providers=[provider]);setup_ms=(time.perf_counter()-begin)*1000
 label=f'{provider}-threads{threads}';report['processors'].append({'label':label,'providers':session.get_providers(),'setupMs':setup_ms})
 for name,a in frames:
  out=session.run(None,{'input':a})[0];diff=np.abs(out-reference[name]);maxerr=float(diff.max());mae=float(diff.mean())
  # Different float kernels can reorder sums; bound the error in normalized range.
  if maxerr>2e-5:raise AssertionError((label,name,maxerr))
  report['validation'].append({'provider':label,'input':name,'maxAbsoluteDifferenceVsOriginalPB':maxerr,'meanAbsoluteDifference':mae,'valuesCompared':out.size})
 for _ in range(5):session.run(None,{'input':frames[0][1]})
 timings=[]
 for i in range(40):
  a=frames[i%5][1];start=time.perf_counter();out=session.run(None,{'input':a})[0];timings.append((time.perf_counter()-start)*1000)
 report['benchmarks'].append({'provider':label,'runs':len(timings),'medianMs':float(np.median(timings)),'p95Ms':float(np.percentile(timings,95)),'minMs':min(timings),'maxMs':max(timings),'input':[1,1,192,256],'output':[1,1,384,512],'includesInputOutputCopies':True,'excludesColorMappingAndIPC':True})
 if provider=='CPUExecutionProvider' and threads==1:
  for name,a in frames[:5]:
   out=session.run(None,{'input':a})[0][0,0];gray=a[0,0];nearest=cv2.resize(gray,(512,384),interpolation=cv2.INTER_NEAREST);bicubic=cv2.resize(gray,(512,384),interpolation=cv2.INTER_CUBIC)
   image=np.concatenate([nearest,bicubic,np.clip(out,0,1)],axis=1);image=np.round(np.clip(image,0,1)*255).astype(np.uint8)
   canvas=np.zeros((416,1536),np.uint8);canvas[32:]=image
   for i,title in enumerate(['Native nearest view','Bicubic x2','FSRCNN x2 display']):cv2.putText(canvas,title,(i*512+12,23),cv2.FONT_HERSHEY_SIMPLEX,.65,255,1,cv2.LINE_AA)
   cv2.imwrite(str(BASE/f'fsrcnn-comparison-{name}.png'),canvas)
   cv2.imwrite(str(BASE/f'fsrcnn-output-{name}.png'),np.round(np.clip(out,0,1)*255).astype(np.uint8))
   report.setdefault('displayDiagnostics',[]).append({'input':name,'rawModelMin':float(out.min()),'rawModelMax':float(out.max()),'meanAbsoluteDifferenceVsBicubic':float(np.abs(out-bicubic).mean()),'comment':'Difference is not a quality score; no high-resolution thermal ground truth.'})
 del session
(BASE/'fsrcnn-benchmark.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps({'benchmarks':report['benchmarks'],'maxConversionDifference':max(x['maxAbsoluteDifferenceVsOriginalPB']for x in report['validation']),'comparisonValues':sum(x['valuesCompared']for x in report['validation'])}))
