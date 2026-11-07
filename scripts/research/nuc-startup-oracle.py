"""Compare startup correction against native using this camera's saved capture."""
import contextlib,io,json,pathlib,runpy,struct,hashlib
ROOT=pathlib.Path(__file__).resolve().parents[2]
with contextlib.redirect_stdout(io.StringIO()): vm=runpy.run_path(str(ROOT/'scripts/research/nuc-tecless-oracle.py'))
u,alloc,rd,call=vm['u'],vm['alloc'],vm['rd'],vm['call']
source=ROOT/'research/shutter-JEHPUQ/sensor.raw'
frame=source.read_bytes()[:117216]
raw=[struct.unpack_from('<H',frame,((y+2)*264+x+4)*2)[0] for y in range(192) for x in range(256)]
gain=list(struct.unpack('<49152H',(ROOT/'research/sk02-device-export-20261107/files/KMatrix.bin').read_bytes()))
# A specified synthetic quarter-background isolates native startup arithmetic;
# it is not presented as this camera's measured shutter calibration.
bg=[(v*4+((i%9)-4))&65535 for i,v in enumerate(raw)]
handle=alloc(0x800);rawp=alloc(struct.pack('<49152H',*raw));gainp=alloc(struct.pack('<49152H',*gain));bgp=alloc(struct.pack('<49152H',*bg))
def wr(off,fmt,v):u.mem_write(handle+off,struct.pack('<'+fmt,v))
wr(6,'H',256);wr(0xc,'I',49152);wr(0xde,'H',5500);wr(0xed,'B',1);wr(0x140,'Q',alloc(64));wr(0x150,'Q',alloc(64));wr(0x69c,'h',1526)
outputs=[alloc(8) for _ in range(4)]
status=call('NUC_TECLESS30_Process',handle,rawp,gainp,bgp,1526,*outputs)
got=struct.unpack('<49152H',rd(rawp,98304))
expected=[max(0,min(16383,5500+((r*4-b)*k//131072))) for r,b,k in zip(raw,bg,gain)]
assert status==0 and list(got)==expected
out=ROOT/'research/nuc-startup-own-capture.json'
out.write_text(json.dumps(dict(frameSha256=hashlib.sha256(frame).hexdigest(),pixels=49152,allMatched=True,status=status,background='synthetic-quarter-counts',correctedSha256=hashlib.sha256(rd(rawp,98304)).hexdigest(),nativeInvalid=rd(outputs[3],1)[0],nativeDrift=rd(outputs[2],1)[0])))
print(out.read_text())
