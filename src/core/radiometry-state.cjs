'use strict';

// Portable SK02 float-online branch. The addresses in the accompanying research
// notes identify the independently checked arithmetic; no vendor code is loaded.
const f = Math.fround;
const EPS = 2 ** -23;
const KELVIN = f(273.15);
function signedSensor(word) {
  const v = word & 0x3fff;
  return word & 0x2000 ? 8192 - v : v;
}
function prepareRadiometry(calibration, metadata, { ambientC = 20 } = {}) {
  if (!Buffer.isBuffer(calibration) || calibration.length !== 14336) throw new Error('Expected a 14336-byte device calibration');
  if (!Buffer.isBuffer(metadata) || metadata.length < 1024) throw new Error('Expected two compact metadata rows');
  if (!Number.isFinite(ambientC)) throw new Error('Invalid ambient temperature');
  const u = o => calibration.readUInt32LE(o);
  const c = o => { const v = calibration.readFloatLE(o); if (!Number.isFinite(v)) throw new Error('Non-finite calibration coefficient'); return v; };
  const w = i => metadata.readUInt16LE(i * 2) & 0x3fff;
  if (u(0) !== 0x404 || u(8) !== 83 || calibration.readInt32LE(0x2b10) !== 0) throw new Error('Unsupported radiometry calibration branch');
  if (calibration.subarray(16, 48).toString('ascii').split('\0')[0] !== 'HM-TJ12-3AAY1F') throw new Error('Unsupported detector calibration model');
  if (c(0x27f4) !== 1) throw new Error('Unsupported external optics calibration');
  const gear = w(5), range = w(13), lens = 0;
  if (gear > 4 || range > 4 || w(8) !== 192 || w(9) !== 256) throw new Error('Invalid normalized metadata');
  if (gear !== 1 || range > 2) throw new Error('Unsupported SK02 radiometry range or gear');
  if (w(1) === 0) throw new Error('Missing live sensor metadata');
  if (w(6) !== 0 || w(7) !== 0 || metadata.readUInt32LE(512 + 28) !== 0) throw new Error('Frame is not eligible for radiometry');
  // Default reference mode (parameter 22=0), lens=0: image-derived blackbody reference and optional
  // additional lens correction paths are deliberately excluded.
  if (metadata.readUInt32LE(512 + 0x44) === 1) throw new Error('Unsupported metadata correction override');
  const sensor = i => f(f(signedSensor(w(i)) * c(0x27ec)) + c(0x27f0));
  const fpaC = sensor(0), cavC = sensor(1), referenceCavC = c(0x26c + range * 20 + gear * 4);
  const t = range * 20 + gear * 4;
  const p = range * 180 + gear * 36;
  const r = range * 160 + gear * 32;
  const z = f(f(cavC - referenceCavC) / 10000), zz = f(z * z);
  const linear = f(f(f(z * c(0x24cc + r)) + f(zz * c(0x24d0 + r))) + 1);
  let quadratic = f(f(z * c(0x24d4 + r)) + f(zz * c(0x24d8 + r)));
  if (quadratic < EPS && quadratic > -EPS) quadratic = 0;
  if (linear < f(.01) || linear > 5) throw new Error('Invalid detector responsivity');
  const pi = range * 340 + gear * 68;
  const gain = c(0xcfc + p), offset = c(0xcf8 + p);
  const a = f(c(0x654 + pi) * gain), b = c(0x658 + pi), d = c(0x660 + pi);
  const absoluteC = f(f(c(0x65c + pi) * gain) + offset);
  const reference = c(0xd00 + p) !== 0 && c(0x64 + range * 4) >= 1100 ? c(0xd00 + p) : referenceCavC;
  const denominator = f(Math.exp(f(b / f(reference + KELVIN))) - d);
  const referenceGray = Math.trunc(f(f(a / denominator) + absoluteC));
  if (referenceGray < 0 || referenceGray > 16383 || !Number.isFinite(referenceGray)) throw new Error('Invalid reference gray');
  const planck = { a, b, c: f(absoluteC - referenceGray), d };
  if (a <= 0 || b <= 0 || d <= 0 || c(0x3758 + range * 16) !== 0) throw new Error('Unsupported radiometry response correction');
  const referenceAmbient = c(0x460 + t);
  const referenceDifference = f(referenceCavC - referenceAmbient);
  const currentDifference = f(Math.min(c(0x2898), Math.max(c(0x28a8), f(cavC - f(ambientC)))));
  const breakpoint = c(0x1e90 + r), lowerSlope = c(0x1e94 + r), upperSlope = c(0x1e98 + r);
  let drift;
  if (breakpoint >= referenceDifference) {
    drift = breakpoint >= currentDifference
      ? f(f(currentDifference - referenceDifference) * lowerSlope)
      : f(f(f(breakpoint - referenceDifference) * lowerSlope) + f(f(currentDifference - breakpoint) * upperSlope));
  } else {
    drift = breakpoint < currentDifference
      ? f(f(currentDifference - referenceDifference) * upperSlope)
      : f(f(f(currentDifference - breakpoint) * lowerSlope) + f(f(breakpoint - referenceDifference) * upperSlope));
  }
  const driftGray = Math.trunc(Math.max(-1000, Math.min(1000, drift)));
  const baseGray = 8192 - driftGray;
  return { version: 0x404, deviceType: 83, lens, range, gear, fpaC, cavC, referenceCavC,
    referenceGray, baseGray, linear, quadratic, planck,
    minimumC: c(0x50 + range * 4), maximumC: c(0x64 + range * 4) };
}
function grayToBlackbody(gray, state) {
  if (!Number.isInteger(gray) || gray < 0 || gray > 16383) return { status: -19, celsius: null };
  const { linear, quadratic, baseGray, planck: { a, b, c, d } } = state;
  const delta = f(gray - baseGray);
  let corrected;
  if (Math.abs(quadratic) < EPS) corrected = f(delta / linear);
  else {
    const discriminant = f(f(f(4 * quadratic) * delta) + f(linear * linear));
    if (discriminant < 0) return { status: -19, celsius: null };
    corrected = f(f(f(Math.sqrt(discriminant)) - linear) / f(quadratic + quadratic));
  }
  corrected = f(Math.trunc(corrected));
  if (corrected <= c) return { status: -19, celsius: null };
  const ratio = f(d + f(a / f(corrected - c)));
  if (ratio < 1) return { status: -19, celsius: null };
  const log = Math.log(ratio);
  if (!Number.isFinite(log) || Math.abs(log) < EPS) return { status: -19, celsius: null };
  let celsius = f(f(b / log) - KELVIN), status = 0;
  if (celsius < state.minimumC) { celsius = state.minimumC; status = -301; }
  if (celsius > state.maximumC) { celsius = state.maximumC; status = -300; }
  return { status, celsius };
}
module.exports = { prepareRadiometry, grayToBlackbody, signedSensor };
