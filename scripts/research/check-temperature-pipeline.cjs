'use strict';
// Offline-only integration/throughput check. Never opens a camera or USB control.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createFactoryProcessor } = require('../../src/core/factory-processor.cjs');
const { createRadiometry } = require('../../src/core/radiometry.cjs');
const args = Object.create(null);
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!['--export', '--serial', '--reference', '--scene'].includes(key) || !value || args[key]) throw new Error('Usage: node check-temperature-pipeline.cjs --export DIR --serial SERIAL --reference CLOSED_SENSOR_RAW --scene SCENE_SENSOR_RAW');
  args[key] = value;
}
for (const key of ['--export', '--serial', '--reference', '--scene']) if (!args[key]) throw new Error(`Missing ${key}`);
const FRAME_BYTES = 117216;
function recording(file, maxFrames) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size || stat.size % FRAME_BYTES || stat.size > FRAME_BYTES * maxFrames) throw new Error(`Invalid bounded recording: ${file}`);
  const bytes = fs.readFileSync(file);
  return { bytes, frames: stat.size / FRAME_BYTES, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
const reference = recording(args['--reference'], 64), scene = recording(args['--scene'], 1000);
const factory = createFactoryProcessor({ calibrationFolder: args['--export'], expectedSerial: args['--serial'] });
const radiometry = createRadiometry(fs.readFileSync(path.join(args['--export'], 'thermometry-calibration.bin')), { serial: args['--serial'] });
const closedFrames = Array.from({ length: reference.frames }, (_, i) => reference.bytes.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES));
const acquisition = factory.setShutterReference(closedFrames, { shutterClosed: true });
const frames = [], times = [], reasons = {};
for (let i = 0; i < scene.frames; i++) {
  const start = performance.now();
  const output = factory.process(scene.bytes.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES));
  const result = output.valid ? radiometry.evaluate(output.corrected, output.metadata)
    : { temperatures: null, calibration: { status: 'unavailable', reason: output.reason } };
  times.push(performance.now() - start);
  const reason = result.calibration.reason || result.calibration.status;
  reasons[reason] = (reasons[reason] || 0) + 1;
  frames.push({ index: i, temperatures: result.temperatures, status: result.calibration.status, reason: result.calibration.reason || null, diagnostics: output.diagnostics });
}
const sorted = [...times].sort((a, b) => a - b);
console.log(JSON.stringify({ researchOnly: true, absoluteAccuracyValidated: false, serial: args['--serial'],
  algorithm: radiometry.algorithm, calibrationSha256: radiometry.calibrationSha256, environment: radiometry.environment,
  reference: { path: path.resolve(args['--reference']), sha256: reference.sha256, frames: reference.frames, closedWindowAssertion: 'caller-supplied' },
  scene: { path: path.resolve(args['--scene']), sha256: scene.sha256, frames: scene.frames }, acquisition, reasons,
  performance: { meanMilliseconds: times.reduce((a, b) => a + b, 0) / times.length, p95Milliseconds: sorted[Math.floor(sorted.length * .95)], maximumMilliseconds: sorted.at(-1) }, frames }, null, 2));
