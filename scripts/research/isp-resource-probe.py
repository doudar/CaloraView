"""Offline APK ISP configuration probe; no device access or runtime integration."""
import pathlib, struct, json, hashlib, io, zipfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
loader = pathlib.Path(__file__).with_name('nuc-tecless-oracle.py')
prefix, marker, _ = loader.read_text().partition('random.seed(20261107)')
if not marker:
    raise RuntimeError('Native loader boundary changed')
prefix = prefix.replace('libifrnuc.so', 'libifrisp.so').replace(
    '98845496b8e3a3f4a0462464434c2a65ece657937d3793de61650822becc9c27',
    'e718fd6f4923044bcd578bc9015ce8d3370c8f0590b964af82d12c45f5ba18fb')
prefix = prefix.replace('u.hook_add(UC_HOOK_CODE,hook)',
    'u.hook_add(UC_HOOK_CODE,hook,begin=0x4002000,end=next_stub-1)')
native = {'__file__': str(loader), '__name__': 'isp_loader'}
exec(compile(prefix, str(loader), 'exec'), native)
u, alloc, call, rd = [native[k] for k in ('u', 'alloc', 'call', 'rd')]
ELFFile = native['ELFFile']
library = ROOT/'research/decompiled/resources/lib/arm64-v8a/libMicroDM_Release_v8a.so'
if hashlib.sha256(library.read_bytes()).hexdigest() != '0ba93d02ddbf53916e4fea8a3f5e65e391e61afd125295c4389bed57c77903af':
    raise ValueError('Embedded resource addresses are specific to the inspected APK')
with library.open('rb') as source:
    elf = ELFFile(source)
    address, length = 0x101c7cf, 966
    segment = next(s for s in elf.iter_segments()
                   if s['p_vaddr'] <= address < s['p_vaddr'] + s['p_filesz'])
    offset = address - segment['p_vaddr']
    resource = segment.data()[offset:offset + length]
archive = zipfile.ZipFile(io.BytesIO(resource))
resources = {}
for entry in archive.infolist():
    kind = entry.filename[:3]
    if kind not in ('AGC', 'DDE', 'DNR') or entry.file_size > 4096:
        raise ValueError('Unexpected embedded ISP resource')
    resources[kind] = archive.read(entry)
if set(resources) != {'AGC', 'DDE', 'DNR'}:
    raise ValueError('Incomplete embedded ISP resource')
ability = alloc(struct.pack('<IIQQ', 256, 192, 0, 0))
table, output = alloc(48), alloc(8)
assert call('IFR_ISP_GetMemSize', ability, table) == 0
for offset in (0, 24):
    size = struct.unpack('<I', rd(table + offset + 8, 4))[0]
    u.mem_write(table + offset, struct.pack('<Q', alloc(size)))
assert call('IFR_ISP_Create', ability, table, output) == 0
handle = struct.unpack('<Q', rd(output, 8))[0]
def state():
    return {hex(offset): rd(handle + offset, size).hex()
            for offset, size in [(0x18, 20), (0x2b0, 16), (0x3a0, 88),
                                 (0x6a0, 56), (0x7b0, 48)]}
report = {'researchOnly': True, 'librarySha256': hashlib.sha256(native['LIB'].read_bytes()).hexdigest(),
          'microDMSha256': hashlib.sha256(library.read_bytes()).hexdigest(),
          'resourceAddress': hex(address), 'initial': state(), 'resources': {},
          'limitation': 'Synthetic zero ability flags: resource parsing and direct sharpness only; not a capture of the complete live ISP configuration.'}
outdir = ROOT/'research/isp-reference'
outdir.mkdir(exist_ok=True)
for kind in ('AGC', 'DDE', 'DNR'):
    data = resources[kind]
    result = call('IFR_ISP_SetConfig', handle, 3, alloc(data), len(data))
    report['resources'][kind] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                                  'status': result, 'state': state()}
    (outdir/(kind + '.bin')).write_bytes(data)
    assert result == 0
report['sharpness'] = {}
for strength in (0, 25, 50, 75, 100):
    assert call('IFR_ISP_SetConfig', handle, 1, alloc(struct.pack('<II', 0x302, strength)), 8) == 0
    assert call('DDE_Params_Refresh', handle) == 0
    report['sharpness'][str(strength)] = {'state': state(),
        'strengthByte': rd(handle + 0x2b4, 1)[0],
        'detailGainQ8': struct.unpack('<H', rd(handle + 0x3d6, 2))[0]}
(outdir/'configuration.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
