'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const MODEL_FILES = ['real-general-dn50-gray2x.onnx', 'fsrcnn-x2.onnx'];
const MODEL_NOTICES = ['NOTICE.md', 'Real-ESRGAN-LICENSE.txt', 'FSRCNN-LICENSE.txt', 'ONNXRuntime-LICENSE.txt', 'real-provenance.json', 'fsrcnn-attribution.json'];

function validateEntries(entries) {
  const allowed = new Set(['package.json', 'LICENSE', 'src', 'node_modules']);
  const normalized = new Set();
  for (const entry of entries) {
    if (typeof entry !== 'string') throw new Error('Invalid package entry');
    const name = entry.replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = name.split('/');
    if (!name || parts.some(part => !part || part === '.' || part === '..') || !allowed.has(parts[0]) || (['package.json', 'LICENSE'].includes(parts[0]) && parts.length !== 1)) {
      throw new Error('Unexpected packaged path: ' + entry);
    }
    if (parts[0] !== 'node_modules') {
      const lower = parts.map(part => part.toLowerCase());
      if (lower.some(part => ['research', 'captures', 'test-output'].includes(part)) || /\.apk$/i.test(name)) {
        throw new Error('Private research/capture material in package: ' + entry);
      }
    }
    normalized.add(name);
  }
  if (!normalized.has('package.json') || !normalized.has('src/main.cjs')) throw new Error('Package is missing its application entry point');
  return normalized;
}

function verifyArchive(archive, api = asar) {
  const entries = validateEntries(api.listPackage(archive));
  const read = name => {
    if (!entries.has(name)) throw new Error('Required packaged file is missing: ' + name);
    const bytes = api.extractFile(archive, name.split('/').join(path.sep));
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('Required packaged file is empty: ' + name);
    return bytes;
  };
  read('LICENSE');
  const prefix = 'src/models/';
  const manifest = JSON.parse(read(prefix + 'manifest.json').toString('utf8').replace(/^\uFEFF/, ''));
  if (manifest.schema !== 'caloraview-super-resolution-v1' || !Array.isArray(manifest.models) || manifest.models.length !== MODEL_FILES.length) {
    throw new Error('Invalid packaged model manifest');
  }
  const names = manifest.models.map(model => model.file);
  if (new Set(names).size !== MODEL_FILES.length || MODEL_FILES.some(name => !names.includes(name))) throw new Error('Unexpected packaged model list');
  for (const model of manifest.models) {
    if (!Number.isSafeInteger(model.bytes) || model.bytes <= 0 || !/^[a-f0-9]{64}$/.test(model.sha256)) throw new Error('Invalid model integrity metadata: ' + model.file);
    const bytes = read(prefix + model.file);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== model.bytes || digest !== model.sha256) throw new Error('Packaged model integrity mismatch: ' + model.file);
  }
  for (const notice of MODEL_NOTICES) read(prefix + notice);
  return { entries: entries.size, models: names, notices: MODEL_NOTICES.length };
}

function archivePath(context) {
  const output = context.appOutDir;
  if (typeof output !== 'string' || !path.isAbsolute(output)) throw new Error('Packaging output path must be absolute');
  if (context.electronPlatformName === 'darwin') {
    const filename = context.packager?.appInfo?.productFilename;
    if (typeof filename !== 'string' || !filename || /[\\/]/.test(filename) || filename === '.' || filename === '..') throw new Error('Invalid macOS product filename');
    return path.join(output, filename + '.app', 'Contents', 'Resources', 'app.asar');
  }
  if (!['win32', 'linux'].includes(context.electronPlatformName)) throw new Error('Unsupported packaging platform');
  return path.join(output, 'resources', 'app.asar');
}

async function afterPack(context) {
  const archive = archivePath(context);
  if (!fs.existsSync(archive)) throw new Error('Packaged app.asar was not found: ' + archive);
  const result = verifyArchive(archive);
  console.log('Package guard passed: ' + result.entries + ' allowed entries; both HD models and all license/provenance files verified.');
}
module.exports = afterPack;
module.exports.validateEntries = validateEntries;
module.exports.verifyArchive = verifyArchive;
module.exports.archivePath = archivePath;
if (require.main === module) {
  try { console.log(JSON.stringify(verifyArchive(path.resolve(process.argv[2] || 'dist/win-unpacked/resources/app.asar')))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
