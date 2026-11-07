"""Extract research calibration/image/additional rows from a locally supplied SDMP JPEG.

Verified against the two supplied APK sample JPEGs only; not a general SDMP decoder.
No vendor data is embedded. Never substitute a sample's calibration for another camera.
"""
import argparse, pathlib, struct, json, hashlib

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('jpeg',type=pathlib.Path)
parser.add_argument('--out-dir',type=pathlib.Path,required=True)
args=parser.parse_args()
data=args.jpeg.read_bytes()
if not data.startswith(b'\xff\xd8'):raise ValueError('Not a JPEG')
blocks={};position=2
while position<len(data):
    if data[position]!=255:raise ValueError('Unexpected JPEG marker')
    while data[position]==255:position+=1
    marker=data[position];position+=1
    if marker in (0xd9,0xda):break
    if marker==0x01 or 0xd0<=marker<=0xd7:continue
    if position+2>len(data):raise ValueError('Truncated marker length')
    size=int.from_bytes(data[position:position+2],'big')
    if size<2 or position+size>len(data):raise ValueError('Invalid marker size')
    segment=data[position+2:position+size];position+=size
    if 0xe0<=marker<=0xef and segment.startswith(b'SDMP'):
        if len(segment)<16:raise ValueError('Truncated SDMP header')
        index=struct.unpack_from('<H',segment,6)[0]
        offset=struct.unpack_from('<I',segment,12)[0]
        blocks.setdefault((marker,index),[]).append((offset,segment[16:]))

def reassemble(chunks):
    output=bytearray()
    for offset,chunk in sorted(chunks):
        if offset!=len(output):raise ValueError('Missing or overlapping SDMP segment')
        output.extend(chunk)
    return bytes(output)

def fields(payload):
    if len(payload)<2:raise ValueError('Missing IFD')
    count=struct.unpack_from('<H',payload)[0]
    if 2+count*12>len(payload):raise ValueError('Truncated IFD')
    result={}
    for i in range(count):
        tag,typ,n,value=struct.unpack_from('<HHII',payload,2+i*12)
        if typ not in (1,2,3,4,7):continue
        length=n*{1:1,2:1,3:2,4:4,7:1}[typ]
        if length<=4:raw=struct.pack('<I',value)[:length]
        else:
            if value<2+count*12 or value+length>len(payload):raise ValueError('IFD value out of bounds')
            raw=payload[value:value+length]
        if tag in result:raise ValueError('Duplicate IFD tag')
        result[tag]=raw
    return result

tables={index:fields(reassemble(chunks)) for index,chunks in blocks.items()}
calibration=tables[(0xe2,2)][0x207]
image=tables[(0xe3,5)][0]
metadata=tables[(0xe3,5)][1]
width=struct.unpack('<I',tables[(0xe3,5)][2])[0]
height=struct.unpack('<I',tables[(0xe3,5)][3])[0]
if len(calibration)!=0x3800 or struct.unpack_from('<I',calibration,4)[0]!=len(calibration):raise ValueError('Unexpected calibration length')
if len(image)!=width*height*2 or len(metadata)!=width*4:raise ValueError('Plane length mismatch')
args.out_dir.mkdir(parents=True,exist_ok=True)
manifest={'researchOnly':True,'sourceName':args.jpeg.name,'sourceSha256':hashlib.sha256(data).hexdigest(),'width':width,'height':height,'files':{}}
for name,raw in (('calibration.bin',calibration),('image.bin',image),('metadata.bin',metadata)):
    (args.out_dir/name).write_bytes(raw)
    manifest['files'][name]={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
(args.out_dir/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print(json.dumps(manifest,indent=2))
