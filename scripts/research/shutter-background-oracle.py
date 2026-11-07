"""Offline synthetic native shutter accumulation oracle. No USB or camera data."""
import contextlib, io, json, pathlib, random, runpy, struct
ROOT=pathlib.Path(__file__).resolve().parents[2]
# Reuse the bounded/hash-checked emulator; its existing arithmetic checks also run.
with contextlib.redirect_stdout(io.StringIO()):
    vm=runpy.run_path(str(ROOT/'scripts/research/nuc-tecless-oracle.py'))
u,alloc,rd,call=vm['u'],vm['alloc'],vm['rd'],vm['call']
cases=[];random.seed(20261107)
for case in range(10):
    count=17
    frames=[[random.randrange(65536) for _ in range(count)] for _ in range(16)]
    sensors=[-101+(i%4) for i in range(16)]
    sensors[7]=-101
    history=[100+i for i in range(32)]
    use_history=case%2==1
    handle=alloc(0x800);accum=alloc(count*4);first=alloc(count*2);second=alloc(count*2)
    raw=alloc(count*2);frameinfo=alloc(16);state=alloc(1)
    def wr(off,fmt,value):u.mem_write(handle+off,struct.pack('<'+fmt,value))
    wr(0xc,'I',count);wr(0x22,'B',1);wr(0x24,'B',1);wr(0xea,'B',1)
    wr(0x60a,'B',16);wr(0x620,'Q',accum);wr(0x650,'Q',first);wr(0x658,'Q',second)
    wr(0x150,'Q',alloc(struct.pack('<32h',*history)));wr(0x158,'Q',alloc(32))
    if use_history:wr(0xed,'B',1)
    assert call('IFR_NUC_Cali_BCaliInit',handle)==0
    for i,frame in enumerate(frames):
        u.mem_write(raw,struct.pack('<'+'H'*count,*frame))
        u.mem_write(frameinfo,struct.pack('<QhBB',raw,sensors[i],0,1))
        assert call('IFR_NUC_Cali_BCaliSendRawImg',handle,frameinfo,state)==0
        assert rd(state,1)==bytes([2 if i==15 else 1])
    baseline=struct.unpack('<h',rd(handle+0x69c,2))[0]
    native_sum=list(struct.unpack('<'+'I'*count,rd(accum,count*4)))
    reference=list(struct.unpack('<'+'H'*count,rd(second if use_history else first,count*2)))
    # A seventeenth offered frame must not change the completed accumulation.
    u.mem_write(raw,struct.pack('<'+'H'*count,*([65535]*count)))
    assert call('IFR_NUC_Cali_BCaliSendRawImg',handle,frameinfo,state)==0
    assert list(struct.unpack('<'+'I'*count,rd(accum,count*4)))==native_sum
    wr(0x114,'B',1) # Isolate the proven averaging stage from later drift-state updates.
    background=alloc(count*2)
    assert call('IFR_NUC_Cali_BCaliCalcBMatrix',handle,background)==0
    cases.append(dict(frames=frames,sensorSamples=sensors,baselineSource='history-tail' if use_history else 'acquisition',sensorHistory=history,
        expected=dict(sum=native_sum,reference=reference,backgroundQuarter=list(struct.unpack('<'+'H'*count,rd(background,count*2))),
            sensorBaseline=baseline,imageMean=struct.unpack('<H',rd(handle+0x680,2))[0])))
target=ROOT/'research/shutter-background-synthetic-vectors.json'
target.write_text(json.dumps(cases,indent=2))
print(json.dumps(dict(cases=len(cases),framesPerCase=16,pixelsPerFrame=17,extraFrameIgnored=True,output=str(target)),indent=2))
