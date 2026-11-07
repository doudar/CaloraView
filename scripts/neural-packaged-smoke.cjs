'use strict';
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs');
(async () => {
  const output = path.resolve('test-output/neural-package'); fs.mkdirSync(output, { recursive: true });
  const desktop = await electron.launch({ executablePath: path.resolve('dist/win-unpacked/Caloraview Desktop.exe'),
    args: [], env: { ...process.env, CALORAVIEW_OUTPUT: output } });
  try {
    await desktop.firstWindow();
    const reports = [];
    for (const cpu of [false, true]) {
      const report = await desktop.evaluate(async ({ app }, forceCpu) => {
        const { Worker } = process.getBuiltinModule('worker_threads'), path = process.getBuiltinModule('path');
        const fs = process.getBuiltinModule('fs');
        const manifest = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'src/models/manifest.json'), 'utf8'));
        const input = Float32Array.from({ length: 256*192 }, (_, i) => (i % 256) / 255);
        const worker = new Worker(path.join(app.getAppPath(), 'src/core/neural-worker.cjs'), {
          workerData: { modelDir: path.join(app.getAppPath(), 'src/models') },
          env: { ...process.env, ...(forceCpu ? { CALORAVIEW_SR_PROVIDER: 'cpu' } : {}) }
        });
        return new Promise((resolve, reject) => {
          let ready;
          const timer = setTimeout(() => finish(new Error('Packaged model timed out.')), 60000);
          async function finish(error, value) {
            clearTimeout(timer);
            await worker.terminate();
            if (error) reject(error); else resolve(value);
          }
          worker.once('error', error => finish(error));
          worker.on('message', message => {
            if (message.type === 'failure') return finish(new Error(message.message));
            if (message.type === 'ready') { ready = message; worker.postMessage({ id: 1, gray: input }); }
            if (message.type === 'result') {
              const model = manifest.models.find(item => item.sha256 === message.modelSha256);
              if (!model || message.gray.length !== 512*384 || !message.gray.every(Number.isFinite)) return finish(new Error('Invalid packaged model result.'));
              finish(null, { packaged: app.isPackaged, model: message.model, method: message.method, provider: message.provider,
                width: message.width, height: message.height, inferenceMs: message.inferenceMs, sha256: message.modelSha256, ready: ready.type });
            }
          });
        });
      }, cpu);
      assert.equal(report.packaged, true); assert.equal(report.width, 512); assert.equal(report.height, 384);
      if (cpu) { assert.equal(report.method, 'fsrcnn-x2-display'); assert.equal(report.provider, 'cpu'); }
      reports.push(report);
    }
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ status: 'passed', cameraUsed: false, reports }, null, 2));
    console.log(JSON.stringify({ status: 'passed', cameraUsed: false, reports }));
  } finally { await desktop.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
