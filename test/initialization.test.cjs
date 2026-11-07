'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { waitForCameraFrames } = require('../src/core/initialization.cjs');

function assertReleased(camera) {
  for (const name of ['frame', 'capture-error', 'closed']) assert.equal(camera.listenerCount(name), 0, name);
}

test('initialization waits for the full stable-frame window and releases all listeners', async () => {
  const camera = new EventEmitter(), progress = [];
  const ready = waitForCameraFrames(camera, { count: 3, onProgress: value => progress.push(value) });
  let completed = false;
  ready.then(() => { completed = true; });
  camera.emit('frame'); camera.emit('frame');
  await Promise.resolve();
  assert.equal(completed, false);
  camera.emit('frame');
  await ready;
  assert.deepEqual(progress, [1 / 3, 2 / 3, 1]);
  assertReleased(camera);
});

for (const kind of ['capture-error', 'closed']) {
  test(`initialization fails promptly on ${kind} without leaving frame listeners`, async () => {
    const camera = new EventEmitter();
    const ready = waitForCameraFrames(camera);
    camera.emit('frame');
    camera.emit(kind, new Error('USB removed'));
    await assert.rejects(ready, kind === 'closed' ? /stopped/ : /USB removed/);
    assertReleased(camera);
  });
}

test('a stalled stream times out and cannot complete from late frames', async () => {
  const camera = new EventEmitter();
  const ready = waitForCameraFrames(camera, { timeoutMs: 10 });
  await assert.rejects(ready, /timed out/);
  assertReleased(camera);
  camera.emit('frame');
});
