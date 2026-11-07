'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const INPUT_PIXELS = 256 * 192, OUTPUT_PIXELS = 512 * 384;
let ort, session, chosen, provider, running = false;
function loadModels() {
  const directory = workerData?.modelDir || path.join(__dirname, '../models');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 'caloraview-super-resolution-v1' || manifest.models.length !== 2) throw new Error('Invalid bundled HD model manifest.');
  return manifest.models.map(model => {
    if (!['real-general-dn50-gray2x.onnx', 'fsrcnn-x2.onnx'].includes(model.file)) throw new Error('Unexpected HD model filename.');
    const bytes = fs.readFileSync(path.join(directory, model.file));
    if (bytes.length !== model.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== model.sha256) throw new Error('Bundled HD model integrity check failed.');
    return { ...model, bytes };
  });
}
async function initialize() {
  ort = require('onnxruntime-node');
  const models = loadModels();
  const gpu = process.env.CALORAVIEW_SR_PROVIDER !== 'cpu' && ort.listSupportedBackends().some(p => p.name === 'dml' && p.bundled);
  const options = [ ...(gpu ? [{ model: models[0], ep: { name: 'dml', deviceId: 0 } }, { model: models[0], ep: { name: 'dml', deviceId: 1 } }] : []),
    { model: models[1], ep: 'cpu' } ];
  const errors = [];
  for (const candidate of options) {
    let attempt;
    try {
      attempt = await ort.InferenceSession.create(candidate.model.bytes, {
        executionProviders: [candidate.ep], executionMode: 'sequential', enableMemPattern: false,
        intraOpNumThreads: 4, interOpNumThreads: 1, graphOptimizationLevel: 'all', logSeverityLevel: 3
      });
      const tensor = new ort.Tensor('float32', new Float32Array(INPUT_PIXELS).fill(.5), [1, 1, 192, 256]);
      const feed = { [attempt.inputNames[0]]: tensor };
      await attempt.run(feed);
      let elapsed = 0;
      for (let i = 0; i < 2; i++) {
        const start = performance.now(), out = await attempt.run(feed);
        elapsed += performance.now() - start;
        if (out[attempt.outputNames[0]].data.length !== OUTPUT_PIXELS) throw new Error('Unexpected HD model output dimensions.');
      }
      if (candidate.ep !== 'cpu' && elapsed / 2 > 60) throw new Error('GPU enhancement exceeds the live preview time budget.');
      session = attempt; chosen = candidate.model;
      provider = typeof candidate.ep === 'string' ? candidate.ep : `DirectML GPU ${candidate.ep.deviceId}`;
      parentPort.postMessage({ type: 'ready', model: chosen.model, provider, method: chosen.method });
      return;
    } catch (error) {
      errors.push(error.message);
      if (attempt) await attempt.release().catch(() => {});
    }
  }
  throw new Error(`HD models could not start: ${errors.join(' ')}`);
}
parentPort.on('message', async message => {
  if (!session || running) return parentPort.postMessage({ type: 'failure', message: 'HD worker received an overlapping inference request.' });
  running = true;
  try {
    const gray = message.gray;
    if (!(gray instanceof Float32Array) || gray.length !== INPUT_PIXELS) throw new Error('HD requires one native grayscale frame.');
    for (const value of gray) if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid HD grayscale sample.');
    const start = performance.now();
    const output = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', gray, [1, 1, 192, 256]) });
    const result = output[session.outputNames[0]];
    if (!(result.data instanceof Float32Array) || result.data.length !== OUTPUT_PIXELS) throw new Error('Invalid HD model output.');
    // Own the transfer buffer; never detach storage managed by ONNX Runtime.
    const pixels = new Float32Array(result.data);
    for (let i = 0; i < pixels.length; i++) {
      if (!Number.isFinite(pixels[i])) throw new Error('HD model returned nonfinite pixels.');
      pixels[i] = Math.max(0, Math.min(1, pixels[i]));
    }
    parentPort.postMessage({ type: 'result', id: message.id, gray: pixels, width: 512, height: 384,
      method: chosen.method, model: chosen.model, provider, modelSha256: chosen.sha256,
      inferenceMs: performance.now() - start }, [pixels.buffer]);
  } catch (error) { parentPort.postMessage({ type: 'failure', message: error.message }); }
  finally { running = false; }
});
initialize().catch(error => parentPort.postMessage({ type: 'failure', message: error.message }));
