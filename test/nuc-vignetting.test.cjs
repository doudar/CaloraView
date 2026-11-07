'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {VignettingCorrection}=require('../src/core/nuc-vignetting.cjs');
const vectors=require('./fixtures/vignetting-synthetic.json');
function matrix(kind){const a=new Int16Array(49152);for(let y=0;y<192;y++)for(let x=0;x<256;x++)a[y*256+x]=kind===0?0:kind===1?Math.floor(x/16)*11-Math.floor(y/16)*7-80:kind===2?((x*7+y*19)%801)-400:kind===3?(Math.floor(x/16)%2?-32768:32767):kind===4?Math.floor((x-128)**2/10)+Math.floor((y-96)**2/10)-900:-1;return a;}
test('VC matches native sequence alpha and output hashes for six synthetic maps',()=>{
 for(const vector of vectors){const map=matrix(vector.map),vc=new VignettingCorrection(map);
  for(let frame=0;frame<5;frame++){const a=new Uint16Array(49152);for(let i=0;i<a.length;i++){const x=i%256,y=Math.floor(i/256),v=map[i];const p=frame===0?6000+Math.floor(v/8):frame===1?6000-Math.floor(v/4)+(x%5):frame===2?(x*29+y*43)%16384:frame===3?(x+y)%9:16375+(x+y)%9;a[i]=Math.max(0,Math.min(65535,p));}
   const before=new Uint16Array(a),result=vc.process(a);assert.equal(result.alpha,vector.frames[frame].alpha);assert.equal(crypto.createHash('sha256').update(Buffer.from(result.corrected.buffer)).digest('hex'),vector.frames[frame].sha256);assert.deepEqual(a,before);
  }
 }
});
test('constant minus-one fallback has zero gradients and is identity for14-bit samples',()=>{
 const vc=new VignettingCorrection(new Int16Array(49152).fill(-1));assert.equal(vc.threshold,0);assert.equal(vc.denominator,1n);assert.ok(vc.gradients.every(v=>v===0));
 const raw=Uint16Array.from({length:49152},(_,i)=>i%16384);assert.deepEqual(vc.process(raw).corrected,raw);assert.equal(vc.alpha,0);
});
test('VC template floors negative block means, excludes threshold equality, retains alpha on map replacement',()=>{
 const map=new Int16Array(49152);for(let y=0;y<192;y++)for(let x=0;x<256;x++)map[y*256+x]=Math.floor(x/16)*2-1;
 map[0]=-2;const vc=new VignettingCorrection(map);assert.equal(vc.gradients[1],3);
 vc.setMatrix(matrix(1));const scene=Uint16Array.from(vc.map,v=>6000+Math.floor(v/8));vc.process(scene);assert.notEqual(vc.alpha,0);const previous=vc.alpha;vc.setMatrix(matrix(1));assert.equal(vc.alpha,previous);vc.reset();assert.equal(vc.alpha,0);
 const equal=new VignettingCorrection(matrix(1),{threshold:11});const step=Uint16Array.from({length:49152},(_,i)=>5000+Math.floor((i%256)/16)*11);assert.equal(equal.process(step).alpha,0);
});
test('VC validates dimensions, signed map type and bounded options',()=>{
 assert.throws(()=>new VignettingCorrection(new Uint16Array(49152)));assert.throws(()=>new VignettingCorrection(new Int16Array(10)));
 for(const o of [{smoothing:-1},{smoothing:513},{alphaLimit:4194305},{threshold:65536}])assert.throws(()=>new VignettingCorrection(matrix(0),o));
 assert.throws(()=>new VignettingCorrection(matrix(0)).process(new Uint16Array(10)));
});
