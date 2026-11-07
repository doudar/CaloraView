"""Offline ARM64 reference for isolated bad-pixel correction, with synthetic data only.

Requires the same ignored library/dependencies as nuc-tecless-oracle.py.
This checks the isolated-pixel branch; it does not implement clustered-pixel search.
"""
import pathlib, struct, random, json, math

loader = pathlib.Path(__file__).with_name('nuc-tecless-oracle.py')
prefix, separator, _ = loader.read_text().partition('random.seed(20261107)')
if not separator:
    raise RuntimeError('Research loader boundary changed; review before running')
native = {'__file__': str(loader), '__name__': 'research_nuc_loader'}
exec(compile(prefix, str(loader), 'exec'), native)
u, alloc, call, rd = (native[name] for name in ('u', 'alloc', 'call', 'rd'))
epsilon = struct.unpack('<f', rd(0x37610, 4))[0]
width = height = 9
handle = alloc(0x800)
samples = alloc(16)
flags = alloc(8)
gradients = alloc(8)
mask = alloc(width * height)
image = alloc(width * height * 2)
rows = alloc(struct.pack('<HH', 1, 6))
columns = alloc(struct.pack('<HH', 4, 5))
def put(offset, fmt, value):
    u.mem_write(handle + offset, struct.pack('<' + fmt, value))
for offset, value in [(6, width), (8, height), (0x3ee, 2)]:
    put(offset, 'H', value)
put(0xc, 'I', width * height)
for offset, value in [(0x408, rows), (0x410, columns), (0x440, samples),
                      (0x3f0, flags), (0x448, gradients), (0x468, mask)]:
    put(offset, 'Q', value)

def f32(value):
    return struct.unpack('<f', struct.pack('<f', value))[0]

def expected(values, x, y):
    # Native sample order: NW, W, SW, S, SE, E, NE, N.
    offsets = [(-1,-1),(-1,0),(-1,1),(0,1),(1,1),(1,0),(1,-1),(0,-1)]
    neighbors = [values[(y+dy)*width+x+dx] if 0<=x+dx<width and 0<=y+dy<height else 0 for dx,dy in offsets]
    invalid = [not (0<=x+dx<width and 0<=y+dy<height) for dx,dy in offsets]
    zero_count = neighbors.count(0)
    if zero_count > 3:
        return math.trunc(f32(f32(sum(neighbors)) / f32(8-zero_count+epsilon)))
    differences = [16383 if invalid[i] or invalid[i+4] else abs(neighbors[i]-neighbors[i+4]) for i in range(4)]
    minimum = min(differences)
    selected = [i for i in range(4) if differences[i] == minimum]
    return sum(neighbors[i]+neighbors[i+4] for i in selected)//(2*len(selected))

rng = random.Random(20261107)
cases = []
for index in range(48):
    values = [rng.randrange(16384) for _ in range(width*height)]
    if index % 8 == 0:
        values = [5000] * len(values)  # equal gradients
    if index % 8 == 1:
        values = [0] * len(values)  # zero-neighbor fallback
    if index % 8 == 2:
        values = [v if rng.randrange(3) == 0 else 0 for v in values]
    wanted = values[:]
    for x,y in [(3,0),(4,5)]:
        wanted[y*width+x] = expected(wanted,x,y)
    u.mem_write(image, struct.pack('<'+'H'*len(values), *values))
    status = call('NUC_BPC_DoBPCompensationByMask', handle, image)
    got = list(struct.unpack('<'+'H'*len(values), rd(image,len(values)*2)))
    if status != 0 or got != wanted:
        raise AssertionError((index,status,[(i,a,b) for i,(a,b) in enumerate(zip(got,wanted)) if a!=b]))
    cases.append({'case':index,'corrected':[got[3],got[5*width+4]]})
report = {'cases':len(cases),'correctedPixels':len(cases)*2,'allMatched':True,'nativeFallbackEpsilon':epsilon,
          'scope':'isolated pixels; top edge and interior; synthetic data only','results':cases}
(native['ROOT']/'bpc-isolated-reference.json').write_text(json.dumps(report,indent=2))
print(json.dumps({key:value for key,value in report.items() if key!='results'},indent=2))
