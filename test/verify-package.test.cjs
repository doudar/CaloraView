'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { validateEntries, verifyArchive, archivePath } = require('../scripts/verify-package.cjs');
function fixture() {
  const files = new Map([['package.json', Buffer.from('{}')], ['LICENSE', Buffer.from('synthetic project license')], ['src/main.cjs', Buffer.from('// synthetic entry')]]);
  const models = ['real-general-dn50-gray2x.onnx', 'fsrcnn-x2.onnx'].map((file, index) => {
    const data = Buffer.from('synthetic model ' + index); files.set('src/models/' + file, data);
    return { file, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  });
  files.set('src/models/manifest.json', Buffer.from(JSON.stringify({ schema:'caloraview-super-resolution-v1', models })));
  for (const file of ['NOTICE.md','Real-ESRGAN-LICENSE.txt','FSRCNN-LICENSE.txt','ONNXRuntime-LICENSE.txt','real-provenance.json','fsrcnn-attribution.json']) files.set('src/models/' + file, Buffer.from('synthetic notice'));
  const api = { listPackage: () => ['\\src', '\\node_modules', '\\node_modules\\onnxruntime-node', ...[...files.keys()].map(name => '/' + name)], extractFile: (_archive, name) => files.get(name.split(path.sep).join('/')) };
  return { files, api, models };
}
test('package allowlist rejects accidental root files and private nested research/captures/APKs', () => {
  const good = ['/package.json','/src','/src/main.cjs','/node_modules','/node_modules/example/test-output/index.js'];
  assert.equal(validateEntries(good).size, good.length);
  for (const unwanted of ['/research/private.bin','/test-output/image.png','/README.md','/src/research/table.bin','/src/Captures/frame.png','/src/TEST-OUTPUT/data.json','/src/assets/original.APK','/src/../research/private.bin','/package.json/extra']) {
    assert.throws(() => validateEntries([...good, unwanted]), /packaged path|Private research/);
  }
});
test('packaged models and notices are checked using archive contents and manifest hashes', () => {
  const { api } = fixture();
  const result = verifyArchive('synthetic.asar', api);
  assert.equal(result.models.length, 2); assert.equal(result.notices, 6);
});
test('missing model, license, provenance, entry point or manifest fails packaging', () => {
  for (const name of ['LICENSE','src/models/fsrcnn-x2.onnx','src/models/FSRCNN-LICENSE.txt','src/models/real-provenance.json','src/main.cjs','src/models/manifest.json']) {
    const { files, api } = fixture(); files.delete(name);
    assert.throws(() => verifyArchive('synthetic.asar', api), /missing/);
  }
});
test('corrupt models, empty licenses and duplicate/unexpected models fail packaging', () => {
  let data = fixture(); data.files.set('src/models/fsrcnn-x2.onnx', Buffer.from('corrupt'));
  assert.throws(() => verifyArchive('synthetic.asar', data.api), /integrity mismatch/);
  data = fixture(); data.files.set('src/models/NOTICE.md', Buffer.alloc(0));
  assert.throws(() => verifyArchive('synthetic.asar', data.api), /empty/);
  for (const change of [models => { models[1] = models[0]; }, models => { models[1].file = '../private.onnx'; }, models => { models[1].sha256 = 'invalid'; }]) {
    data = fixture(); change(data.models);
    data.files.set('src/models/manifest.json', Buffer.from(JSON.stringify({schema:'caloraview-super-resolution-v1',models:data.models})));
    assert.throws(() => verifyArchive('synthetic.asar', data.api), /model list|integrity metadata/);
  }
});
test('afterPack resolves Windows and macOS bundle archives without assuming project brand', () => {
  const appOutDir = path.resolve('synthetic-packaged-output');
  assert.equal(archivePath({appOutDir,electronPlatformName:'win32'}), path.join(appOutDir,'resources','app.asar'));
  assert.equal(archivePath({appOutDir,electronPlatformName:'darwin',packager:{appInfo:{productFilename:'Thermal Viewer'}}}), path.join(appOutDir,'Thermal Viewer.app','Contents','Resources','app.asar'));
  assert.throws(() => archivePath({appOutDir:'relative',electronPlatformName:'win32'}), /absolute/);
  assert.throws(() => archivePath({appOutDir,electronPlatformName:'darwin',packager:{appInfo:{productFilename:'../escape'}}}), /filename/);
});
