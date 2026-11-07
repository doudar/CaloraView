'use strict';
// Native-equivalent SK02 software VC branch, 256x192 and 16x16 blocks.
const WIDTH=256, HEIGHT=192, BLOCK=16, COUNT=WIDTH*HEIGHT;
const s16=n=>(n<<16)>>16;
class VignettingCorrection {
  constructor(map,{smoothing=16,alphaLimit=4194304,threshold=null}={}) {
    if (!Number.isInteger(smoothing)||smoothing<0||smoothing>512||!Number.isInteger(alphaLimit)||alphaLimit<0||alphaLimit>4194304
      || (threshold!==null&&(!Number.isInteger(threshold)||threshold<0||threshold>65535))) throw new Error('Invalid vignetting configuration');
    this.smoothing=smoothing;this.alphaLimit=alphaLimit;this.thresholdOverride=threshold;this.alpha=0;this.setMatrix(map);
  }
  setMatrix(map){
    if (!(map instanceof Int16Array)||map.length!==COUNT) throw new Error('Vignetting map must contain 256x192 signed16 samples');
    this.map=new Int16Array(map);this.gradients=new Int16Array((WIDTH/BLOCK)*(HEIGHT/BLOCK));
    let denominator=0,maxGradient=0;
    for(let by=0;by<HEIGHT/BLOCK;by++){
      let previous=0;
      for(let bx=0;bx<WIDTH/BLOCK;bx++){
        let sum=0;for(let y=0;y<BLOCK;y++)for(let x=0;x<BLOCK;x++)sum+=map[(by*BLOCK+y)*WIDTH+bx*BLOCK+x];
        const mean=Math.floor(Math.fround(Math.fround(sum)/(BLOCK*BLOCK)));
        const gradient=bx?s16(mean-previous):0;previous=mean;
        this.gradients[by*(WIDTH/BLOCK)+bx]=gradient;
        denominator+=gradient*gradient;maxGradient=Math.max(maxGradient,Math.abs(gradient));
      }
    }
    this.denominator=BigInt(Math.max(1,denominator));this.threshold=Math.trunc(maxGradient*1.5)&65535;
    // Native SetMatrix retains the previous alpha; only an explicit reset clears it.
  }
  reset(){this.alpha=0;}
  process(image){
    if(!(image instanceof Uint16Array)||image.length!==COUNT)throw new Error('Vignetting image must contain 256x192 unsigned16 samples');
    let correlation=0n;const threshold=this.thresholdOverride??this.threshold;
    for(let by=0;by<HEIGHT/BLOCK;by++){
      let previous=0;
      for(let bx=0;bx<WIDTH/BLOCK;bx++){
        let sum=0;for(let y=0;y<BLOCK;y++)for(let x=0;x<BLOCK;x++)sum+=image[(by*BLOCK+y)*WIDTH+bx*BLOCK+x];
        const mean=Math.trunc(sum/(BLOCK*BLOCK)),difference=s16(mean-previous);previous=mean;
        if(bx&&Math.abs(difference)<threshold)correlation+=BigInt(this.gradients[by*(WIDTH/BLOCK)+bx])*BigInt(difference);
      }
    }
    const estimate=Number(BigInt.asIntN(32,BigInt.asIntN(64,correlation<<20n)/this.denominator));
    const old=this.alpha||estimate;
    const blended=(Math.imul(this.smoothing,estimate)+Math.imul(512-this.smoothing,old))>>9;
    this.alpha=Math.min(this.alphaLimit,Math.max(-this.alphaLimit,blended));
    const corrected=new Uint16Array(COUNT);
    // Products fit exact JS integers for the bounded native alpha/map domain.
    // Native narrows/wraps to uint16 before clipping high; negative results wrap.
    for(let i=0;i<COUNT;i++)corrected[i]=Math.min(16383,(image[i]-Math.floor(this.alpha*this.map[i]/1048576))&65535);
    return {corrected,alpha:this.alpha};
  }
}
module.exports={VignettingCorrection};
