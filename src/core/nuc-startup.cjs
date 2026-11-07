'use strict';

// Native TECLESS30 startup stage: acquisition state ed=1, no drift plane,
// f3=0. Unlike the older mode0 path this uses a wide multiply (0x1ffec).
function applyStartupNuc({raw, gain, background, offset, sensorCounts, baseline, gainBypass=false, upperLimit=16383}={}) {
  for (const [name,data] of Object.entries({raw,gain,background})) if (!(data instanceof Uint16Array)) throw new TypeError(`${name} must be Uint16Array`);
  if (!raw.length || gain.length!==raw.length || background.length!==raw.length) throw new RangeError('Plane lengths must match');
  for (const [name,value,lo,hi] of [['offset',offset,0,65535],['sensorCounts',sensorCounts,-32768,32767],['baseline',baseline,-32768,32767],['upperLimit',upperLimit,0,16383]]) {
    if (!Number.isInteger(value)||value<lo||value>hi) throw new RangeError(`${name} out of range`);
  }
  if(typeof gainBypass!=='boolean') throw new TypeError('gainBypass must be boolean');
  const corrected=new Uint16Array(raw.length);
  let invalidPattern=false, repeated=0, previous=0;
  for(let i=0;i<raw.length;i++) {
    const value=raw[i];
    // Width256 native stuck-pixel pattern detector; tracks runs of ten equal
    // values outside15001..16384, resets before comparing the next pixel.
    if (!repeated) { previous=value; repeated=1; }
    else if (repeated<=9) {
      if ((value>=15001 && value<=16384) || value!==previous) repeated=0;
      else if (++repeated===10) invalidPattern=true;
      previous=value;
    }
    // The largest product is below2^34: every integer is exact in JS Number.
    const difference=(value*4)-background[i];
    const correction=gainBypass ? Math.floor(difference/4) : Math.floor(difference*gain[i]/131072);
    corrected[i]=Math.min(upperLimit,Math.max(0,offset+correction));
  }
  return {corrected,invalidPattern,driftWarning:Math.abs(sensorCounts-baseline)>=13};
}

// Exact float32 enum1/2 arithmetic for a supplied, already selected FPA plane.
// The plane geometry must come from the adapter; this does not infer it.
function calculateFpa({plane,width,height}={}) {
  if(!(plane instanceof Uint16Array)||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||plane.length!==width*height) throw new TypeError('FPA plane geometry mismatch');
  let sum=0,count=0;
  for(let y=0;y<height;y+=10){sum=(sum+plane[y*width+width-1])>>>0;count++;}
  const mean=Math.fround(Math.fround(sum)/Math.fround(count));
  // product of twofloat32 significands +800 is exact within doubleprecision
  // for this bounded unsigned16 input, then one rounding models FMADD.
  const fused=Math.fround(mean*Math.fround(0.146)+800);
  const estimate=Math.fround(Math.fround(Math.fround(fused-2000)/10)+25);
  return {mean,estimate,word:(Math.trunc(estimate)*50)&65535};
}
module.exports={applyStartupNuc,calculateFpa};
