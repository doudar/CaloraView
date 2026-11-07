// Static helper for this ELF: find ADRP + ADD references to selected strings.
const fs = require('fs');
const file = process.argv[2];
const needle = process.argv[3];
if (!file || !needle) throw Error('Usage: node find-arm64-string-xrefs.cjs file.so string');
const b = fs.readFileSync(file);
const target = b.indexOf(Buffer.from(needle));
console.log('String file offset 0x' + target.toString(16));
if (target < 0) process.exit(1);
for (let at = 0xc3550; at + 4 <= Math.min(b.length, 0x2b0fac); at += 4) {
  const op = b.readUInt32LE(at);
  if (((op & 0x9f000000) >>> 0) !== 0x90000000) continue;
  let imm = ((op >>> 29) & 3) | (((op >>> 5) & 0x7ffff) << 2);
  if (imm & 0x100000) imm -= 0x200000;
  const base = (at & ~4095) + imm * 4096;
  const reg = op & 31;
  for (let next = at + 4; next < Math.min(at + 64, b.length); next += 4) {
    const add = b.readUInt32LE(next);
    if (((add & 0xff000000) >>> 0) !== 0x91000000 || ((add >>> 5) & 31) !== reg) continue;
    const offset = ((add >>> 10) & 4095) * ((add & 0x400000) ? 4096 : 1);
    if (base + offset === target) console.log('0x' + at.toString(16) + ' -> ADD at 0x' + next.toString(16));
  }
}
