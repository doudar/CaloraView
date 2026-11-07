'use strict';

// SK02 resource mode 1: horizontal bilateral residual, averaged separately
// over four row bands. Integer narrowing/rounding follows the native branch.
function correctFixedPattern(image, { width = 256, height = 192, threshold = 15, shift = 2 } = {}) {
  if (!(image instanceof Uint16Array) || image.length !== width * height || !Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 4 || height % 4) throw new RangeError('FPN requires a complete image with four equal row bands.');
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255 || !Number.isInteger(shift) || shift < 0 || shift > 15) throw new RangeError('Invalid FPN parameters.');
  const weights = [5, 4, 4, 3, 3, 2, 2, 1, 0];
  const coefficients = new Int16Array(width * 4);
  const bandHeight = height / 4;
  for (let y = 0; y < height; y++) {
    const row = y * width, band = Math.floor(y / bandHeight) * width;
    for (let x = 0; x < width; x++) {
      const center = image[row + x];
      let difference = 0, weighted = center * 32, divisor = 32;
      for (let delta = -4; delta <= 4; delta++) {
        if (!delta) continue;
        let neighbor = x + delta;
        if (neighbor < 0) neighbor = -neighbor;
        else if (neighbor >= width) neighbor = 2 * width - 2 - neighbor;
        const value = image[row + neighbor];
        const distance = Math.abs(center - value);
        difference += distance;
        const weight = 1 << weights[Math.min(8, distance >>> shift)];
        weighted += value * weight;
        divisor += weight;
      }
      if (difference <= threshold * 9) coefficients[band + x] += center - Math.floor((weighted + Math.floor(divisor / 2)) / divisor);
    }
  }
  for (let i = 0; i < coefficients.length; i++) {
    const value = coefficients[i];
    coefficients[i] = Math.trunc((value * 4 + (value > 0 ? height / 2 : -height / 2)) / height);
  }
  const corrected = new Uint16Array(image.length);
  for (let y = 0; y < height; y++) {
    const band = Math.floor(y / bandHeight) * width;
    for (let x = 0; x < width; x++) corrected[y * width + x] = Math.min(16383, (image[y * width + x] - coefficients[band + x]) & 65535);
  }
  return { corrected, coefficients };
}
module.exports = { correctFixedPattern };
