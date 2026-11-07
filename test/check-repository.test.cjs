'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePath } = require('../scripts/check-repository.cjs');
test('repository guard rejects vendor assets, private outputs and signing material', () => {
  for (const file of ['original.apk', 'src/vendor.so', 'assets/camera.bin', 'src/models/vendor.onnx', 'tools/key.keystore', 'research/report.json', 'src/decompiled/source.java', 'test-output/report.json', 'dist/package.json', '../secret.txt']) assert.throws(() => validatePath(file), /repository|Unapproved/);
});
test('repository guard permits source, docs, synthetic fixtures and approved assets', () => {
  for (const file of ['src/main.cjs', 'scripts/research/mtlib-oracle.py', '.github/workflows/release.yml', 'LICENSE', 'tools/android-calibration-export/.gitignore', 'test/fixtures/environment-synthetic.json', 'src/models/fsrcnn-x2.onnx']) assert.doesNotThrow(() => validatePath(file));
});
