'use strict';

// Clean-room SK02 83/404 producer and float-online kind189 consumer. This is
// experimental until the preceding live NUC/DDAC sequence is validated. No
// vendor code or tables are embedded; each camera supplies its own calibration.
const { prepareRadiometry } = require('./radiometry-state.cjs');
const f = Math.fround;

function generateInter(calibration, metadata, options = {}) {
  const state = prepareRadiometry(calibration, metadata, options);
  const c = offset => {
    const value = calibration.readFloatLE(offset);
    if (!Number.isFinite(value)) throw new Error('Non-finite generated-reference coefficient');
    return value;
  };
  const r = state.range * 160 + state.gear * 32;
  const p = state.range * 180 + state.gear * 36;
  // These native alternatives have not been independently reproduced. Reject
  // them rather than silently treating a different camera's branch as SK02.
  if (c(0xd00 + p) !== 0) throw new Error('Unsupported generated-reference blackbody target');
  if (c(0x1ea0 + r) !== 0 || c(0x1ea4 + r) !== 0 || c(0x1ea8 + r) !== 0) {
    throw new Error('Unsupported secondary generated-reference correction');
  }
  const { a, b, c: offset, d } = state.planck;
  const denominator = f(Math.exp(f(b / f(state.cavC + f(273.15)))) - d);
  const currentCavGray = Math.trunc(f(f(a / denominator) + offset));
  const responsivityGray = Math.trunc(f(f(state.linear * currentCavGray)
    + f(f(state.quadratic * currentCavGray) * currentCavGray)));
  const factor = f(c(0x1e8c + r) + f(f(state.cavC - state.referenceCavC) * c(0x1e9c + r)));
  const interGray = Math.trunc(f(f(state.referenceGray) - f(factor * responsivityGray)));
  if (!Number.isFinite(currentCavGray) || !Number.isFinite(responsivityGray) || !Number.isFinite(factor)
      || !Number.isInteger(interGray) || interGray < 0 || interGray > 16383) {
    throw new Error('Generated reference outside native 14-bit range');
  }
  // MT_GetInterParam exports all three. The inspected OL consumer uses inter0
  // for its base and recomputes responsivity from calibration, not inter1/2.
  const inter = [interGray, Math.trunc(f(state.linear * 1e7)), Math.trunc(f(state.quadratic * 1e7)), 0];
  return { inter, currentCavGray, responsivityGray, factor, state };
}

function prepareGeneratedRadiometry(calibration, metadata, options = {}) {
  const generated = generateInter(calibration, metadata, options);
  const { state, inter } = generated;
  // The existing preparation gives 8192 - current ambient-dependent drift.
  // MT_CalcBaseGray_OL substitutes inter0 for8192, applying that drift once.
  const baseGray = inter[0] + state.baseGray - 8192;
  if (!Number.isInteger(baseGray) || baseGray < 0 || baseGray > 16383) {
    throw new Error('Generated consumer base outside native 14-bit range');
  }
  return { ...state, baseGray, generatedReference: {
    interGray: inter[0], linearEncoded: inter[1], quadraticEncoded: inter[2],
    currentCavGray: generated.currentCavGray, responsivityGray: generated.responsivityGray,
    factor: generated.factor, source: 'device-calibration-and-live-cav', experimental: true,
  } };
}

module.exports = { generateInter, prepareGeneratedRadiometry };
