'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
test('Windows control bridge preserves packet layout and always recovers shutter using a fake transport', { skip: process.platform !== 'win32' || !fs.existsSync(compiler), timeout: 30000 }, t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caloraview-ks-test-'));
  const executable = path.join(folder, 'KsControlPackingCheck.exe');
  t.after(() => { if (fs.existsSync(executable)) fs.unlinkSync(executable); fs.rmdirSync(folder); });
  const compile = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${executable}`,
    path.resolve(__dirname, '../scripts/protocol/KsCameraControl.cs'), path.resolve(__dirname, 'fixtures/KsControlPackingCheck.cs')],
  { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  const result = spawnSync(executable, [], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS: KS layout/);
});
