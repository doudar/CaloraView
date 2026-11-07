'use strict';

// Display processing only. Detector samples, temperatures and their native
// coordinates are never resampled or overwritten by this module.
const ROTATIONS = new Set([0, 90, 180, 270]);
const axes = new Map();
function axis(length) {
  if (axes.has(length)) return axes.get(length);
  const indices = new Int32Array(length * 8), weights = new Float64Array(length * 8);
  for (let p = 0; p < length * 2; p++) {
    // Pixel-center convention: destination pixel p samples (p+.5)/2-.5.
    const source = (p + .5) / 2 - .5, base = Math.floor(source), t = source - base;
    const t2 = t * t, t3 = t2 * t, offset = p * 4;
    weights.set([-.5 * t + t2 - .5 * t3, 1 - 2.5 * t2 + 1.5 * t3,
      .5 * t + 2 * t2 - 1.5 * t3, -.5 * t2 + .5 * t3], offset);
    for (let j = 0; j < 4; j++) indices[offset + j] = Math.max(0, Math.min(length - 1, base + j - 1));
  }
  const result = { indices, weights };
  // Bound the cache even if a caller supplies many image geometries.
  if (axes.size >= 8) axes.delete(axes.keys().next().value);
  axes.set(length, result);
  return result;
}
function boundedCubic(a, b, c, d, weights, i) {
  const value = a * weights[i] + b * weights[i + 1] + c * weights[i + 2] + d * weights[i + 3];
  // Catmull-Rom preserves sharp edges; limiting to the central interval avoids
  // bright/dark ringing and invented palette extremes at hard transitions.
  return Math.max(Math.min(b, c), Math.min(Math.max(b, c), value));
}
function upscale2x(rgba, width, height) {
  const outputWidth = width * 2, outputHeight = height * 2;
  const horizontal = new Float32Array(outputWidth * height * 4);
  const output = Buffer.allocUnsafe(outputWidth * outputHeight * 4);
  const xa = axis(width), ya = axis(height);
  for (let y = 0; y < height; y++) {
    const sourceRow = y * width * 4, targetRow = y * outputWidth * 4;
    for (let x = 0; x < outputWidth; x++) {
      const i = x * 4;
      const a = sourceRow + xa.indices[i] * 4, b = sourceRow + xa.indices[i + 1] * 4;
      const c = sourceRow + xa.indices[i + 2] * 4, d = sourceRow + xa.indices[i + 3] * 4;
      for (let ch = 0; ch < 4; ch++) horizontal[targetRow + i + ch] = boundedCubic(rgba[a + ch], rgba[b + ch], rgba[c + ch], rgba[d + ch], xa.weights, i);
    }
  }
  for (let y = 0; y < outputHeight; y++) {
    const i = y * 4, targetRow = y * outputWidth * 4;
    const a = ya.indices[i] * outputWidth * 4, b = ya.indices[i + 1] * outputWidth * 4;
    const c = ya.indices[i + 2] * outputWidth * 4, d = ya.indices[i + 3] * outputWidth * 4;
    for (let x = 0; x < outputWidth * 4; x++) output[targetRow + x] = Math.round(boundedCubic(horizontal[a + x], horizontal[b + x], horizontal[c + x], horizontal[d + x], ya.weights, i));
  }
  return output;
}
function rotatePoint(x, y, width, height, rotation) {
  if (rotation === 90) return { x: height - 1 - y, y: x };
  if (rotation === 180) return { x: width - 1 - x, y: height - 1 - y };
  if (rotation === 270) return { x: y, y: width - 1 - x };
  return { x, y };
}
function rotateRgba(rgba, width, height, rotation) {
  if (!rotation) return rgba;
  const output = Buffer.allocUnsafe(rgba.length), targetWidth = rotation === 180 ? width : height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let tx, ty;
    if (rotation === 90) { tx = height - 1 - y; ty = x; }
    else if (rotation === 180) { tx = width - 1 - x; ty = height - 1 - y; }
    else { tx = y; ty = width - 1 - x; }
    const from = (y * width + x) * 4, to = (ty * targetWidth + tx) * 4;
    output[to] = rgba[from]; output[to + 1] = rgba[from + 1];
    output[to + 2] = rgba[from + 2]; output[to + 3] = rgba[from + 3];
  }
  return output;
}
function transformPreview(frame, { resolution = 'native', rotation = 0, enhanced = null } = {}) {
  const { width, height, rgba } = frame || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width * height > 1048576 || !(rgba instanceof Uint8Array) || rgba.length !== width * height * 4) throw new Error('Expected complete bounded RGBA preview');
  if (!['native', 'enhanced'].includes(resolution) || !ROTATIONS.has(rotation)) throw new Error('Unsupported display resolution or rotation');
  const scale = resolution === 'enhanced' ? 2 : 1;
  const scaledWidth = width * scale, scaledHeight = height * scale;
  if (enhanced && (scale !== 2 || enhanced.width !== scaledWidth || enhanced.height !== scaledHeight
      || !(enhanced.rgba instanceof Uint8Array) || enhanced.rgba.length !== scaledWidth * scaledHeight * 4
      || !['realesrgan-x4v3-display', 'fsrcnn-x2-display'].includes(enhanced.method))) throw new Error('Invalid enhanced preview dimensions or method.');
  const scaled = enhanced ? Buffer.from(enhanced.rgba) : scale === 2 ? upscale2x(rgba, width, height) : Buffer.from(rgba);
  const validPoint = (x, y) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x < width && y >= 0 && y < height;
  const temperature = frame.temperatures;
  const calibrated = frame.calibration?.status === 'factory-calibrated'
    && ['center', 'high', 'low'].every(key => Number.isFinite(temperature?.[key]))
    && validPoint(temperature.highX, temperature.highY) && validPoint(temperature.lowX, temperature.lowY);
  const points = calibrated ? temperature : frame.stats;
  const map = (x, y) => validPoint(x, y) ? rotatePoint((x + .5) * scale - .5, (y + .5) * scale - .5, scaledWidth, scaledHeight, rotation) : null;
  return { ...frame,
    rgba: rotateRgba(scaled, scaledWidth, scaledHeight, rotation),
    width: rotation % 180 ? scaledHeight : scaledWidth,
    height: rotation % 180 ? scaledWidth : scaledHeight,
    displayMarkers: { source: calibrated ? 'temperature' : 'detector',
      center: map(Math.floor(width / 2), Math.floor(height / 2)),
      high: map(points?.highX, points?.highY), low: map(points?.lowX, points?.lowY) },
    displayTransform: { resolution, rotation, scale, nativeWidth: width, nativeHeight: height,
      method: enhanced?.method || (scale === 2 ? 'bounded-bicubic-display' : 'native'), measurementResolution: 'native',
      ...(enhanced ? { model: enhanced.model, provider: enhanced.provider, modelSha256: enhanced.modelSha256, inferenceMs: enhanced.inferenceMs } : {}) },
  };
}
module.exports = { transformPreview, rotatePoint };
