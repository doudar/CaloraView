'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
const { NeuralPreview } = require('../src/core/neural-preview.cjs');

class FakeWorker extends EventEmitter {
  constructor() { super(); this.sent = []; this.terminations = 0; }
  postMessage(message, transfers) {
    assert.equal(transfers, undefined, 'Camera display plane must not be detached');
    this.sent.push(structuredClone(message));
  }
  terminate() { this.terminations++; return this.termination || Promise.resolve(1); }
  ready() { this.emit('message', { type: 'ready', model: 'FSRCNN x2', method: 'fsrcnn-x2-display', provider: 'cpu' }); }
  result(id) { this.emit('message', { type: 'result', id, gray: new Float32Array(512 * 384), width: 512, height: 384, method: 'fsrcnn-x2-display', model: 'FSRCNN x2', provider: 'cpu', modelSha256: 'test', inferenceMs: 12 }); }
}
function job(sequence) { return { sequence, nativeFrame: { displayGray: new Float32Array(256 * 192).fill(sequence / 10), temperatures: { center: 20 + sequence }, privateRaw: new Uint16Array(256 * 192) } }; }
function harness(options = {}) {
  const worker = new FakeWorker(), calls = [], states = [], frames = [], failures = [];
  const coordinator = new NeuralPreview({ ...options, workerFactory: (file, config) => { calls.push({ file, config }); return worker; } });
  coordinator.on('state', value => states.push(value));
  coordinator.on('frame', value => frames.push(value));
  coordinator.on('failure', value => failures.push(value));
  return { worker, coordinator, calls, states, frames, failures };
}

test('lazy idempotent initialization supplies model directory and sends only a cloned display plane', async () => {
  const h = harness({ modelDir: path.resolve('synthetic-models') }), input = job(1);
  assert.equal(h.calls.length, 0); assert.equal(h.coordinator.submit(input), false);
  h.coordinator.start(); h.coordinator.start();
  assert.equal(h.calls.length, 1); assert.equal(path.basename(h.calls[0].file), 'neural-worker.cjs');
  assert.equal(h.calls[0].config.workerData.modelDir, path.resolve('synthetic-models'));
  assert.equal(h.states[0].enhancementState, 'loading');
  assert.equal(h.coordinator.submit(input), false);
  h.worker.ready(); assert.equal(h.states[1].enhancementState, 'ready');
  assert.equal(h.coordinator.submit(input), true);
  const sent = h.worker.sent[0]; assert.deepEqual(Object.keys(sent), ['id', 'gray']);
  assert.notStrictEqual(sent.gray.buffer, input.nativeFrame.displayGray.buffer);
  sent.gray[0] = 99; assert.notEqual(input.nativeFrame.displayGray[0], 99);
  assert.equal(input.nativeFrame.displayGray.byteLength, 256 * 192 * 4);
  h.worker.result(sent.id);
  assert.strictEqual(h.frames[0].job, input); assert.equal(h.frames[0].result.provider, 'cpu');
  assert.equal(h.coordinator.active, null); await h.coordinator.close();
});

test('one active plus latest pending rejects stale/out-of-order results and preserves matching job', async () => {
  const h = harness(); h.coordinator.start(); h.worker.ready();
  const a = job(1), b = job(2), c = job(3);
  h.coordinator.submit(a); h.coordinator.submit(b); h.coordinator.submit(c);
  assert.equal(h.worker.sent.length, 1); assert.strictEqual(h.coordinator.pending, c);
  h.worker.result(999); assert.equal(h.frames.length, 0); assert.equal(h.worker.sent.length, 1);
  h.worker.result(h.worker.sent[0].id);
  assert.strictEqual(h.frames[0].job, a); assert.equal(h.worker.sent.length, 2);
  assert.equal(h.coordinator.pending, null); assert.strictEqual(h.coordinator.active.job, c);
  h.worker.result(h.worker.sent[0].id); assert.equal(h.frames.length, 1);
  h.worker.result(h.worker.sent[1].id); assert.strictEqual(h.frames[1].job, c);
  await h.coordinator.close();
});

test('cancel releases queued jobs and suppresses old frame while allowing latest new work', async () => {
  const h = harness(); h.coordinator.start(); h.worker.ready();
  h.coordinator.submit(job(1)); h.coordinator.submit(job(2));
  const oldId = h.worker.sent[0].id;
  h.coordinator.cancel(); assert.equal(h.coordinator.pending, null); assert.equal(h.coordinator.active.job, null);
  const replacement = job(3); h.coordinator.submit(replacement);
  assert.equal(h.worker.sent.length, 1);
  h.worker.result(oldId); assert.equal(h.frames.length, 0); assert.equal(h.worker.sent.length, 2);
  h.worker.result(h.worker.sent[1].id); assert.strictEqual(h.frames[0].job, replacement);
  await h.coordinator.close();
});

test('frame listeners may replace pending work or close without future dispatch', async () => {
  const h = harness(); h.coordinator.start(); h.worker.ready();
  h.coordinator.submit(job(1)); h.coordinator.submit(job(2));
  const newest = job(3); h.coordinator.once('frame', () => h.coordinator.submit(newest));
  h.worker.result(h.worker.sent[0].id); assert.strictEqual(h.coordinator.active.job, newest);
  h.coordinator.submit(job(4)); h.coordinator.once('frame', () => h.coordinator.close());
  h.worker.result(h.worker.sent[1].id); assert.equal(h.worker.sent.length, 2);
  await h.coordinator.close(); assert.equal(h.worker.terminations, 1);
});

test('crashes, explicit failure, unexpected exit and malformed output fall back once without retry', async () => {
  for (const failure of [w => w.emit('error', new Error('crashed')), w => w.emit('message', { type:'failure', message:'model rejected' }), w => w.emit('exit', 0), w => w.emit('message', { type:'result', id:w.sent[0].id, gray:new Float32Array(1), width:512,height:384 })]) {
    const h = harness(); h.coordinator.start(); h.worker.ready(); h.coordinator.submit(job(1)); h.coordinator.submit(job(2));
    failure(h.worker); assert.equal(h.states.at(-1).enhancementState, 'fallback'); assert.equal(h.failures.length, 1);
    assert.equal(h.coordinator.active, null); assert.equal(h.coordinator.pending, null); assert.equal(h.coordinator.submit(job(3)), false);
    h.worker.emit('error', new Error('late')); h.worker.emit('exit', 1); h.worker.ready(); h.coordinator.start();
    assert.equal(h.failures.length, 1); assert.equal(h.calls.length, 1);
    await h.coordinator.close(); assert.equal(h.worker.terminations, 1);
  }
});

test('initialization and inference watchdogs terminate stalled worker and release frames', async () => {
  for (const inference of [false, true]) {
    const h = harness({ initTimeoutMs: 20, inferenceTimeoutMs: 20 }); h.coordinator.start();
    if (inference) { h.worker.ready(); h.coordinator.submit(job(1)); h.coordinator.submit(job(2)); h.coordinator.cancel(); }
    await delay(65);
    assert.equal(h.failures.length, 1); assert.match(h.failures[0], /timed out/);
    assert.equal(h.worker.terminations, 1); assert.equal(h.coordinator.active, null); assert.equal(h.coordinator.pending, null);
    await h.coordinator.close();
  }
});

test('close waits for termination, is idempotent and suppresses every late worker event', async () => {
  const h = harness(); let finish;
  h.worker.termination = new Promise(resolve => { finish = resolve; });
  h.coordinator.start(); h.worker.ready(); h.coordinator.submit(job(1));
  const count = h.states.length; let completed = false;
  const closing = h.coordinator.close().then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false);
  h.worker.result(h.worker.sent[0].id); h.worker.ready(); h.worker.emit('error', new Error('late')); h.worker.emit('exit', 1);
  assert.equal(h.states.length, count); assert.equal(h.frames.length, 0); assert.equal(h.failures.length, 0);
  assert.equal(h.coordinator.submit(job(2)), false); h.coordinator.start(); assert.equal(h.calls.length, 1);
  finish(1); await closing; await h.coordinator.close(); assert.equal(h.worker.terminations, 1);
});

test('invalid inputs and worker construction/post failures cannot leave unbounded work', async () => {
  assert.throws(() => new NeuralPreview({ initTimeoutMs: 0 }), /positive/);
  const h = harness(); h.coordinator.start(); h.worker.ready();
  for (const input of [null, {}, {nativeFrame:{displayGray:new Float32Array(1)}}]) assert.equal(h.coordinator.submit(input), false);
  h.worker.postMessage = () => { throw new Error('post failed'); };
  assert.equal(h.coordinator.submit(job(1)), false); assert.match(h.failures[0], /post failed/); await h.coordinator.close();
  const failed = new NeuralPreview({ workerFactory: () => { throw new Error('construct failed'); } });
  const states = []; failed.on('state', state => states.push(state)); failed.start();
  assert.equal(states.at(-1).enhancementState, 'fallback'); await failed.close();
  const neverStarted = harness(); await neverStarted.coordinator.close(); neverStarted.coordinator.start(); assert.equal(neverStarted.calls.length, 0);
});


test('cancel from frame listener does not leave an idle inference watchdog', async () => {
  const h = harness({ inferenceTimeoutMs:20 }); h.coordinator.start(); h.worker.ready();
  h.coordinator.submit(job(1)); h.coordinator.once('frame', () => h.coordinator.cancel());
  h.worker.result(h.worker.sent[0].id); await delay(50);
  assert.equal(h.failures.length, 0); assert.equal(h.coordinator.timer, null);
  await h.coordinator.close();
});
