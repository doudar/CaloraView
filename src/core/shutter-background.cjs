'use strict';

// Offline arithmetic only. The caller must supply exactly 8 or 16 frames already
// accepted by the native shutter state machine. This does not choose those frames,
// move the shutter, mark a gear ready, construct drift maps or calculate Celsius.
function summarizeAcceptedShutterFrames({ frames, sensorSamples, baselineSource, sensorHistory, referenceCount = 16 } = {}) {
  if (![8, 16].includes(referenceCount)) throw new RangeError('referenceCount must be 8 or 16.');
  if (!Array.isArray(frames) || frames.length !== referenceCount) throw new RangeError(`Exactly ${referenceCount} accepted shutter frames are required.`);
  const pixels = frames[0]?.length;
  if (!pixels || pixels > 256 * 192 || frames.some(frame => !(frame instanceof Uint16Array) || frame.length !== pixels)) {
    throw new TypeError('Frames must be equal-sized Uint16Array planes of at most 256x192 pixels.');
  }
  if (!(sensorSamples instanceof Int16Array) || sensorSamples.length !== referenceCount) throw new TypeError(`Exactly ${referenceCount} signed sensor samples are required.`);
  if (!['acquisition', 'history-tail'].includes(baselineSource)) throw new TypeError('An explicit baselineSource is required.');
  if (baselineSource === 'history-tail' && (!(sensorHistory instanceof Int16Array) || sensorHistory.length !== 32)) {
    throw new TypeError('The history-tail branch requires exactly 32 signed sensor-history entries.');
  }
  const sum = new Uint32Array(pixels), reference = new Uint16Array(pixels), backgroundQuarter = new Uint16Array(pixels);
  for (const frame of frames) for (let i = 0; i < pixels; i++) sum[i] += frame[i];
  let imageSum = 0n;
  for (let i = 0; i < pixels; i++) {
    // 0x21574..580 versus 0x21a78..a90: divide before narrowing to uint16.
    reference[i] = Math.floor(sum[i] / referenceCount);
    backgroundQuarter[i] = Math.floor(sum[i] / (referenceCount >> 2));
    imageSum += BigInt(backgroundQuarter[i] >>> 2);
  }
  // 0x21aac..ad0: truncated Q32 reciprocal, unsigned64 round, low16 store.
  const reciprocal = (0x100000000n / BigInt(pixels)) & 0xffffffffn;
  const imageMean = Number(((reciprocal * imageSum + 0x80000000n) >> 32n) & 0xffffn);
  const filteredSensorSamples = new Int16Array(sensorSamples);
  // 0x2127c..0x212c8: half-count minus one, then signed16 rejection.
  const anchor = sensorSamples[(referenceCount >> 1) - 1];
  for (let i = 0; i < referenceCount; i++) {
    const difference = ((sensorSamples[i] - anchor) << 16) >> 16;
    if (Math.abs(difference) >= 3) filteredSensorSamples[i] = anchor;
  }
  const baselineSamples = baselineSource === 'history-tail' ? sensorHistory.subarray(32 - referenceCount) : filteredSensorSamples;
  const sensorBaseline = Math.trunc(baselineSamples.reduce((total, sample) => total + sample, 0) / referenceCount);
  return { sum, reference, backgroundQuarter, imageMean, sensorBaseline, filteredSensorSamples };
}

module.exports = { summarizeAcceptedShutterFrames };
