'use strict';
// Proven isolated-defect subset of native BPC; rejects clusters instead of
// silently using an unported neighbor-search path. Coordinates stay unrotated.
function parseBadPixels(bytes,width=256,height=192) {
 if(!Buffer.isBuffer(bytes)||bytes.length%4||bytes.length>16384)throw new Error('Invalid BPM length');
 const points=[];const seen=new Set();
 for(let at=0;at<bytes.length&&points.length<2048;at+=4){const record=bytes.readUInt32LE(at);if(record===0||record===0xffffffff)break;const x=(record&4095)-1,y=((record>>>12)&4095)-1;if(x<0||y<0||x>=width||y>=height)continue;const key=y*width+x;if(seen.has(key))continue;seen.add(key);points.push({x,y});}
 for(const a of points)for(const b of points)if(a!==b&&Math.abs(a.x-b.x)<=1&&Math.abs(a.y-b.y)<=1)throw new Error('Clustered factory bad pixels require the native extended neighbor search');
 return points;
}
function correctIsolatedBadPixels(input,points,width=256,height=192) {
 if(!(input instanceof Uint16Array)||input.length!==width*height)throw new TypeError('BPC image geometry mismatch');
 const output=new Uint16Array(input),offsets=[[-1,-1],[-1,0],[-1,1],[0,1],[1,1],[1,0],[1,-1],[0,-1]];
 for(const {x,y} of points){if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=width||y>=height)throw new RangeError('Invalid bad-pixel coordinate');const unavailable=[],values=offsets.map(([dx,dy],i)=>{const xx=x+dx,yy=y+dy;unavailable[i]=xx<0||yy<0||xx>=width||yy>=height;return unavailable[i]?0:output[yy*width+xx];});const zeros=values.filter(v=>v===0).length;let replacement;
  if(zeros>3)replacement=Math.trunc(Math.fround(Math.fround(values.reduce((a,b)=>a+b,0))/Math.fround(8-zeros+2**-23)));
  else {const gradients=Array.from({length:4},(_,i)=>unavailable[i]||unavailable[i+4]?16383:Math.abs(values[i]-values[i+4]));const minimum=Math.min(...gradients);let sum=0,n=0;for(let i=0;i<4;i++)if(gradients[i]===minimum){sum+=values[i]+values[i+4];n+=2;}replacement=Math.floor(sum/n);}
  output[y*width+x]=replacement;
 }
 return output;
}
module.exports={parseBadPixels,correctIsolatedBadPixels};
