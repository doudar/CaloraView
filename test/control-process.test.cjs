'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function fakeTransport({ exists = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = 0;
  child.kill = () => { child.killCalls++; };
  const calls = [];
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, process: { platform: 'win32' },
    require(name) {
      if (name === 'node:child_process') return { spawn(...args) { calls.push(args); return child; } };
      if (name === 'node:fs') return { existsSync() { return exists; } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/core/controls.cjs'), 'utf8'), context, { filename: 'controls.cjs' });
  return { child, calls, api: module.exports };
}

const device = '@device_pnp_\\?\\usb#vid_38be&pid_0184&mi_00#unique-instance';
const stage = name => JSON.stringify({ type: 'stage', stage: name, timestamp: '2026-11-07T14:52:38.515Z' }) + '\n';
const result = (ok = true) => JSON.stringify({ type: 'result', ok, error: ok ? undefined : 'Device rejected operation' }) + '\n';

test('control helper JSON can span pipe chunks; completion waits for child exit', async () => {
  const { api, child, calls } = fakeTransport();
  const stages = [];
  const operation = api.shutterReference('control.exe', device, event => stages.push(event.stage));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'control.exe');
  assert.deepEqual(Array.from(calls[0][1]), ['shutter-reference', device]);
  assert.equal(calls[0][2].windowsHide, true);
  const first = stage('closed');
  child.stdout.write(first.slice(0, 13));
  assert.equal(stages.length, 0);
  child.stdout.write(first.slice(13) + '\r\n' + stage('opening') + stage('opened') + result());
  let settled = false;
  operation.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  child.emit('close', 0);
  const completed = await operation;
  assert.equal(completed.result.ok, true);
  assert.deepEqual(stages, ['closed', 'opening', 'opened']);
  assert.equal(child.killCalls, 0);
});

test('successful JSON without confirmed reopening is rejected', async () => {
  const { api, child } = fakeTransport();
  const operation = api.shutterReference('control.exe', device, () => {});
  const rejection = assert.rejects(operation, /did not confirm reopening/);
  child.stdout.write(stage('closed') + result());
  child.emit('close', 0);
  await rejection;
  assert.equal(child.killCalls, 0);
});

test('stage callback failure still lets native finally cleanup finish before reporting failure', async () => {
  const { api, child } = fakeTransport();
  const operation = api.shutterReference('control.exe', device, event => {
    if (event.stage === 'closed') throw new Error('Frame collection failed');
  });
  const rejection = assert.rejects(operation, /Frame collection failed/);
  child.stdout.write(stage('closed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(child.killCalls, 0);
  child.stdout.write(stage('opening') + stage('opened') + result());
  child.emit('close', 0);
  await rejection;
});

test('malformed output never kills the helper and fails after recovery/exit', async () => {
  const { api, child } = fakeTransport();
  const operation = api.shutterReference('control.exe', device, () => {});
  const rejection = assert.rejects(operation, /JSON|Unexpected|position|property/i);
  child.stdout.write('{malformed\n' + stage('opening') + stage('opened') + result());
  assert.equal(child.killCalls, 0);
  child.emit('close', 0);
  await rejection;
});

test('native errors and unavailable/wrong-device requests are surfaced without guessing', async () => {
  const missing = fakeTransport({ exists: false });
  assert.throws(() => missing.api.shutterReference('missing.exe', device, () => {}), /Windows build only/);
  assert.equal(missing.calls.length, 0);
  const wrong = fakeTransport();
  assert.throws(() => wrong.api.shutterReference('control.exe', 'ordinary-webcam', () => {}), /verified SK02/);
  assert.equal(wrong.calls.length, 0);
  const { api, child } = fakeTransport();
  const operation = api.shutterReference('control.exe', device, () => {});
  const rejection = assert.rejects(operation, /Device rejected operation/);
  child.stdout.write(result(false));
  child.emit('close', 1);
  await rejection;
});
