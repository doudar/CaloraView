"""Convert one hash-pinned Apache-2.0 FSRCNN TF frozen graph to fixed-size ONNX.
No TensorFlow dependency: decode the bounded GraphDef constants directly.
Original PB inference via OpenCV independently validates the resulting graph.
"""
from pathlib import Path
import sys,struct,collections,json,hashlib
ROOT=Path(__file__).resolve().parents[2];BASE=ROOT/'research/neural-sr'
sys.path.insert(0,str(BASE/'fsrcnn-deps'))
import numpy as np,onnx
from onnx import helper,numpy_helper,TensorProto
PB_SHA='366b33f0084c7b3f2bf6724f0a2c77bca94fcec9d7b6d72389d330073b380d5c'
def var(b,i):
 v=0;s=0
 while True:
  x=b[i];i+=1;v|=(x&127)<<s
  if x<128:return v,i
  s+=7
  if s>64:raise ValueError('Malformed protobuf varint')
def parse(b):
 i=0;out=collections.defaultdict(list)
 while i<len(b):
  key,i=var(b,i);n,w=key>>3,key&7
  if w==0:v,i=var(b,i)
  elif w==1:v=b[i:i+8];i+=8
  elif w==2:k,i=var(b,i);v=b[i:i+k];i+=k
  elif w==5:v=b[i:i+4];i+=4
  else:raise ValueError('Unsupported wire type')
  if i>len(b):raise ValueError('Truncated protobuf')
  out[n].append(v)
 return out
def tensor(attr):
 t=parse(attr[8][0]);assert t[1]==[1]
 shape=[parse(d).get(1,[0])[0]for d in parse(t[2][0]).get(2,[])];size=int(np.prod(shape))
 if 4 in t:a=np.frombuffer(t[4][0],dtype='<f4').copy()
 else:
  values=b''.join(t.get(5,[]));a=np.frombuffer(values,dtype='<f4').copy()
  if a.size==1 and size>1:a=np.repeat(a,size)
 assert a.size==size
 return a.reshape(shape)
def convert():
 pb=(BASE/'fsrcnn-x2.pb').read_bytes();assert hashlib.sha256(pb).hexdigest()==PB_SHA
 constants={}
 for entry in parse(pb)[1]:
  node=parse(entry)
  if node[2][0]!=b'Const':continue
  attrs={}
  for item in node.get(5,[]):
   a=parse(item);attrs[a[1][0].decode()]=parse(a[2][0])
  if node[1][0].decode().startswith(('f','b','alpha')):constants[node[1][0].decode()]=tensor(attrs['value'])
 nodes=[];initializers=[];previous='input';shapes=[]
 for i in range(1,9):
  w=constants['f'+str(i)];shapes.append(list(w.shape));kernel=w.shape[:2]
  weight=np.transpose(w,(3,2,0,1)).copy();initializers.append(numpy_helper.from_array(weight,'w'+str(i)))
  inputs=[previous,'w'+str(i)];out='conv'+str(i)
  if i<8:initializers.append(numpy_helper.from_array(constants['b'+str(i)],'b'+str(i)));inputs.append('b'+str(i))
  nodes.append(helper.make_node('Conv',inputs,[out],name=out,kernel_shape=list(kernel),pads=[kernel[0]//2,kernel[1]//2]*2))
  if i<8:
   alpha=constants['alpha'+str(i)].reshape(-1,1,1);initializers.append(numpy_helper.from_array(alpha,'a'+str(i)))
   previous='prelu'+str(i);nodes.append(helper.make_node('PRelu',[out,'a'+str(i)],[previous],name=previous))
  else:previous=out
 nodes.append(helper.make_node('DepthToSpace',[previous],['shuffled'],blocksize=2,mode='DCR'))
 initializers.append(numpy_helper.from_array(constants['b8'].reshape(1,1,1,1),'output_bias'))
 nodes.append(helper.make_node('Add',['shuffled','output_bias'],['output']))
 graph=helper.make_graph(nodes,'Saafke-FSRCNN-x2', [helper.make_tensor_value_info('input',TensorProto.FLOAT,[1,1,192,256])],[helper.make_tensor_value_info('output',TensorProto.FLOAT,[1,1,384,512])],initializers)
 model=helper.make_model(graph,producer_name='Caloraview bounded FSRCNN converter',opset_imports=[helper.make_opsetid('',13)]);model.ir_version=10
 model.doc_string='Apache-2.0 Saafke/FSRCNN_Tensorflow. Exact original float32 weights, NHWC->NCHW kernel layout, SAME padding, PReLU algebraic folding, x2 subpixel. Input normalized grayscale0..1. Display only.'
 onnx.checker.check_model(model);onnx.save(model,BASE/'fsrcnn-x2.onnx')
 report={'source':'https://github.com/Saafke/FSRCNN_Tensorflow','pbSha256':PB_SHA,'onnxSha256':hashlib.sha256((BASE/'fsrcnn-x2.onnx').read_bytes()).hexdigest(),'bytes':(BASE/'fsrcnn-x2.onnx').stat().st_size,'kernelShapesHWIO':shapes,'input':[1,1,192,256],'output':[1,1,384,512],'opset':13,'irVersion':10,'license':'Apache-2.0','transform':'float32 weights copied exactly; HWIO->OIHW; fused PReLU; DepthToSpace2 DCR; separate last bias','semanticClaim':'Numerical equivalence must be measured against original PB; floating operations need not be bit-exact.'}
 (BASE/'fsrcnn-conversion.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report))
if __name__=='__main__':convert()
