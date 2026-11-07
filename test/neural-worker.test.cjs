'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), crypto = require('node:crypto');
const workerPath = path.resolve(__dirname, '../src/core/neural-worker.cjs');
const modelDir = path.resolve(__dirname, '../src/models');

function nextMessage(worker, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('HD worker response timed out')), timeout);
    function finish(error, value) {
      clearTimeout(timer); worker.off('message', message); worker.off('error', failure); worker.off('exit', exit);
      if (error) reject(error); else resolve(value);
    }
    const message = value => finish(null, value);
    const failure = error => finish(error);
    const exit = code => finish(new Error(`HD worker exited before its response: ${code}`));
    worker.once('message', message); worker.once('error', failure); worker.once('exit', exit);
  });
}
function start(t, directory = modelDir) {
  const worker = new Worker(workerPath, { workerData: { modelDir: directory }, env: { ...process.env, CALORAVIEW_SR_PROVIDER: 'cpu' } });
  t.after(() => worker.terminate());
  return worker;
}

test('real CPU HD worker selects FSRCNN, preserves input and returns verified finite 2x pixels', { timeout: 30000 }, async t => {
  const worker = start(t), ready = await nextMessage(worker);
  assert.equal(ready.type, 'ready', JSON.stringify(ready));
  assert.equal(ready.model, 'FSRCNN'); assert.equal(ready.provider, 'cpu');
  const gray = Float32Array.from({ length: 49152 }, (_, i) => (i % 256) / 255);
  const before = new Float32Array(gray);
  const response = nextMessage(worker); worker.postMessage({ id: 'ramp', gray });
  const result = await response;
  assert.equal(result.type, 'result', JSON.stringify(result)); assert.equal(result.id, 'ramp');
  assert.equal(result.width, 512); assert.equal(result.height, 384);
  assert.equal(result.model, 'FSRCNN'); assert.equal(result.method, 'fsrcnn-x2-display');
  assert.equal(result.gray.length, 196608); assert.ok(result.gray instanceof Float32Array);
  assert.ok(result.gray.every(v => Number.isFinite(v) && v >= 0 && v <= 1));
  assert.ok(result.inferenceMs > 0 && Number.isFinite(result.inferenceMs));
  assert.equal(result.modelSha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(modelDir, 'fsrcnn-x2.onnx'))).digest('hex'));
  assert.deepEqual(gray, before); assert.equal(gray.byteLength, 49152 * 4);
  assert.ok(result.gray[192 * 512 + 460] > result.gray[192 * 512 + 50], 'The ramp must survive the actual network');

  const bad = new Float32Array(gray); bad[20] = NaN;
  const rejected = nextMessage(worker); worker.postMessage({ id: 'invalid', gray: bad });
  assert.match((await rejected).message, /Invalid HD grayscale sample/);
  const recovered = nextMessage(worker); worker.postMessage({ id: 'recovered', gray });
  assert.equal((await recovered).id, 'recovered', 'Invalid input must not leave the worker busy');
});

test('HD worker rejects a tampered model before inference initialization', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caloraview-sr-integrity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifest = JSON.parse(fs.readFileSync(path.join(modelDir, 'manifest.json')));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, manifest.models[0].file), Buffer.from('tampered'));
  const worker = start(t, dir), result = await nextMessage(worker);
  assert.equal(result.type, 'failure'); assert.match(result.message, /integrity check failed/);
});
