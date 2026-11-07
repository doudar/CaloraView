'use strict';

// SK02 AY1 advertises YUY2, but each pair of bytes is a detector word, not
// luminance/chroma. Keep all 264 × 222 words in saved raw frames. The APK's F2
// crop routine begins at byte 0x428 (x4, y2), copying 192 rows of 512 bytes with
// a 528-byte source stride. Neither the advertised format nor this crop establishes
// a Celsius conversion. Factory NUC and radiometric calibration are separate.
const PROFILE = Object.freeze({
  id: 'accumems-sk02-ay1',
  width: 264,
  height: 222,
  fps: 25,
  frameBytes: 117216,
  imageWidth: 256,
  imageHeight: 192,
  cropX: 4,
  cropY: 2,
});

const PIXELS = PROFILE.imageWidth * PROFILE.imageHeight;
const palettes = Object.freeze({
  iron: Object.freeze([[0, 0, 0], [30, 4, 60], [95, 10, 105], [180, 35, 75], [240, 100, 22], [255, 200, 60], [255, 255, 235]].map(Object.freeze)),
  inferno: Object.freeze([[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]].map(Object.freeze)),
  gray: Object.freeze([[0, 0, 0], [255, 255, 255]].map(Object.freeze)),
  rainbow: Object.freeze([[26, 5, 80], [40, 40, 190], [0, 160, 235], [0, 210, 120], [220, 235, 30], [255, 120, 0], [215, 15, 25]].map(Object.freeze)),
});

function makeLut(anchors) {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const pos = i / 255 * (anchors.length - 1);
    const left = Math.min(Math.floor(pos), anchors.length - 2);
    const fraction = pos - left;
    for (let channel = 0; channel < 3; channel++) {
      lut[i * 3 + channel] = Math.round(anchors[left][channel] * (1 - fraction) + anchors[left + 1][channel] * fraction);
    }
  }
  return lut;
}

const LUTS = Object.fromEntries(Object.entries(palettes).map(([name, anchors]) => [name, makeLut(anchors)]));

function asBuffer(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected a Buffer or Uint8Array of raw camera bytes.');
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Assemble byte-exact frames, without interpreting or discarding metadata. */
class FrameAssembler {
  constructor(frameBytes = PROFILE.frameBytes) {
    if (!Number.isSafeInteger(frameBytes) || frameBytes <= 0) throw new RangeError('frameBytes must be a positive integer.');
    this.frameBytes = frameBytes;
    this.remainder = Buffer.alloc(0);
  }

  get pendingBytes() { return this.remainder.length; }

  reset() { this.remainder = Buffer.alloc(0); }

  push(bytes) {
    const chunk = asBuffer(bytes);
    if (!chunk.length) return [];
    const data = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    const count = Math.floor(data.length / this.frameBytes);
    const frames = new Array(count);
    for (let i = 0; i < count; i++) {
      // Own the data: callers may reuse an input buffer after push returns.
      frames[i] = Buffer.from(data.subarray(i * this.frameBytes, (i + 1) * this.frameBytes));
    }
    // Copy the tail so a tiny remainder cannot retain a large input allocation.
    this.remainder = Buffer.from(data.subarray(count * this.frameBytes));
    return frames;
  }
}

function readDetector(bytes) {
  const frame = asBuffer(bytes);
  if (frame.length !== PROFILE.frameBytes) {
    throw new RangeError(`Expected ${PROFILE.frameBytes} bytes per SK02 frame; received ${frame.length}.`);
  }
  const detector = new Float32Array(PIXELS);
  let i = 0;
  for (let y = 0; y < PROFILE.imageHeight; y++) {
    const row = ((y + PROFILE.cropY) * PROFILE.width + PROFILE.cropX) * 2;
    for (let x = 0; x < PROFILE.imageWidth; x++) detector[i++] = frame.readUInt16LE(row + x * 2);
  }
  return detector;
}

function rawStats(detector) {
  let high = -Infinity;
  let low = Infinity;
  let highIndex = 0;
  let lowIndex = 0;
  for (let i = 0; i < detector.length; i++) {
    if (detector[i] > high) { high = detector[i]; highIndex = i; }
    if (detector[i] < low) { low = detector[i]; lowIndex = i; }
  }
  return {
    center: detector[Math.floor(PROFILE.imageHeight / 2) * PROFILE.imageWidth + Math.floor(PROFILE.imageWidth / 2)],
    high,
    low,
    highX: highIndex % PROFILE.imageWidth,
    highY: Math.floor(highIndex / PROFILE.imageWidth),
    lowX: lowIndex % PROFILE.imageWidth,
    lowY: Math.floor(lowIndex / PROFILE.imageWidth),
  };
}

/**
 * Decode a raw frame to a relative-intensity preview. `detector` and `stats`
 * ALWAYS retain the original detector counts. A user-captured flat field changes
 * only the preview; it is not factory NUC or temperature calibration.
 */
function decodeFrame(bytes, { flatField = null, factoryPlane = null, palette = 'iron' } = {}) {
  if (!Object.hasOwn(LUTS, palette)) throw new RangeError(`Unknown palette: ${String(palette)}`);
  const detector = readDetector(bytes);
  const stats = rawStats(detector);
  if (factoryPlane !== null && (!(factoryPlane instanceof Uint16Array) || factoryPlane.length !== PIXELS)) throw new RangeError('Factory preview requires one complete corrected detector plane.');
  let display = factoryPlane || detector;
  if (!factoryPlane && flatField !== null && flatField !== undefined) {
    if (!(flatField instanceof Float32Array) || flatField.length !== PIXELS) {
      throw new RangeError(`Flat field must be a Float32Array with ${PIXELS} detector values.`);
    }
    let mean = 0;
    for (const value of flatField) {
      if (!Number.isFinite(value) || value < 0 || value > 65535) throw new RangeError('Flat field contains an invalid detector value.');
      mean += value;
    }
    mean /= PIXELS;
    display = new Float32Array(PIXELS);
    for (let i = 0; i < PIXELS; i++) display[i] = detector[i] - flatField[i] + mean;
  }

  const ordered = display.slice().sort();
  const levelLow = ordered[Math.floor((PIXELS - 1) * 0.01)];
  const levelHigh = ordered[Math.ceil((PIXELS - 1) * 0.99)];
  const span = levelHigh - levelLow;
  const displayGray = new Float32Array(PIXELS);
  const rgba = Buffer.allocUnsafe(PIXELS * 4);
  const lut = LUTS[palette];
  for (let i = 0; i < PIXELS; i++) {
    displayGray[i] = span > 0 ? Math.max(0, Math.min(1, (display[i] - levelLow) / span)) : 128 / 255;
    const index = Math.round(displayGray[i] * 255);
    rgba[i * 4] = lut[index * 3];
    rgba[i * 4 + 1] = lut[index * 3 + 1];
    rgba[i * 4 + 2] = lut[index * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return {
    rgba,
    width: PROFILE.imageWidth,
    height: PROFILE.imageHeight,
    detector,
    stats,
    temperatures: null,
    displayGray,
    displayRange: { low: levelLow, high: levelHigh },
  };
}

/** Average a uniform-target capture for visual fixed-pattern subtraction only. */
function makeFlatField(rawFrames) {
  if (!Array.isArray(rawFrames) || !rawFrames.length) throw new RangeError('At least one complete raw frame is required for a flat field.');
  const sums = new Float64Array(PIXELS);
  for (const frame of rawFrames) {
    const detector = readDetector(frame);
    for (let i = 0; i < PIXELS; i++) sums[i] += detector[i];
  }
  return Float32Array.from(sums, value => value / rawFrames.length);
}

function colorizeGray(gray, palette = 'iron') {
  if (!(gray instanceof Float32Array) || gray.length > 1048576 || !Object.hasOwn(LUTS, palette)) throw new Error('Invalid display grayscale image or palette.');
  const rgba = Buffer.allocUnsafe(gray.length * 4), lut = LUTS[palette];
  for (let i = 0; i < gray.length; i++) {
    if (!Number.isFinite(gray[i])) throw new Error('Display grayscale contains nonfinite pixels.');
    const index = Math.max(0, Math.min(255, Math.round(gray[i] * 255)));
    rgba[i*4] = lut[index*3]; rgba[i*4+1] = lut[index*3+1]; rgba[i*4+2] = lut[index*3+2]; rgba[i*4+3] = 255;
  }
  return rgba;
}
module.exports = { PROFILE, FrameAssembler, decodeFrame, makeFlatField, palettes, colorizeGray };
