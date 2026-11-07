'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { captureArgs, parseDevices, Replay } = require('../src/core/capture.cjs');
const { PROFILE } = require('../src/core/thermal.cjs');

test('Windows capture preserves raw bytes and treats device identity as one argument', () => {
  const id = '@device_pnp_\\?\\usb#vid_38be&pid_0184&mi_00#device';
  const args = captureArgs(id, 'win32');
  assert.equal(args[args.indexOf('-f') + 1], 'dshow');
  assert.equal(args[args.indexOf('-i') + 1], `video=${id}`);
  assert.equal(args[args.indexOf('-pixel_format') + 1], 'yuyv422');
  assert.equal(args[args.indexOf('-video_size') + 1], '264x222');
  assert.equal(args[args.indexOf('-framerate') + 1], '25');
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.deepEqual(args.slice(-3), ['-f', 'rawvideo', 'pipe:1']);
  assert.ok(!args.includes('-vf'));
  assert.ok(!args.includes('-pix_fmt'));
});

test('macOS capture uses AVFoundation and requests the same byte-preserving input format', () => {
  const args = captureArgs('3', 'darwin');
  assert.equal(args[args.indexOf('-f') + 1], 'avfoundation');
  assert.equal(args[args.indexOf('-i') + 1], '3:none');
  assert.equal(args[args.indexOf('-pixel_format') + 1], 'yuyv422');
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.throws(() => captureArgs('0', 'linux'), /Windows and macOS/);
});

test('DirectShow enumeration prefers unique hardware paths and excludes microphones', () => {
  const stderr = [
    '[dshow @ 0001] "UVC Camera" (video)',
    '[dshow @ 0001]   Alternative name "@device_pnp_camera1"',
    '[dshow @ 0001] "UVC Camera" (video)',
    '[dshow @ 0001]   Alternative name "@device_pnp_camera2"',
    '[dshow @ 0001] "Microphone" (audio)',
    '[dshow @ 0001]   Alternative name "@device_cm_audio"',
    'Error opening input file dummy.',
  ].join('\r\n');
  assert.deepEqual(parseDevices(stderr, 'win32'), [
    { name: 'UVC Camera', id: '@device_pnp_camera1' },
    { name: 'UVC Camera', id: '@device_pnp_camera2' },
  ]);
  assert.deepEqual(parseDevices('No devices found.', 'win32'), []);
});

test('AVFoundation enumeration separates video and audio index namespaces', () => {
  const stderr = [
    '[AVFoundation indev @ 0x123] AVFoundation video devices:',
    '[AVFoundation indev @ 0x123] [0] FaceTime HD Camera',
    '[AVFoundation indev @ 0x123] [1] UVC Camera',
    '[AVFoundation indev @ 0x123] AVFoundation audio devices:',
    '[AVFoundation indev @ 0x123] [0] MacBook Microphone',
  ].join('\n');
  assert.deepEqual(parseDevices(stderr, 'darwin'), [
    { name: 'FaceTime HD Camera', id: '0' },
    { name: 'UVC Camera', id: '1' },
  ]);
});

test('raw replay preserves complete frames and terminates at EOF', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caloraview-replay-test-'));
  const filename = path.join(folder, 'frames.raw');
  const first = Buffer.alloc(PROFILE.frameBytes, 17);
  const second = Buffer.alloc(PROFILE.frameBytes, 238);
  fs.writeFileSync(filename, Buffer.concat([first, second]));
  const replay = new Replay();
  t.after(async () => {
    await replay.stop();
    fs.unlinkSync(filename);
    fs.rmdirSync(folder);
  });
  const frames = [];
  replay.on('frame', value => frames.push(value));
  const ended = once(replay, 'ended');
  await replay.start(filename);
  await ended;
  assert.deepEqual(frames, [first, second]);
  assert.equal(replay.handle, null);
});

test('raw replay rejects empty and incomplete recordings before opening a stream', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'caloraview-replay-invalid-'));
  const filename = path.join(folder, 'partial.raw');
  t.after(() => { fs.unlinkSync(filename); fs.rmdirSync(folder); });
  const replay = new Replay();
  fs.writeFileSync(filename, Buffer.alloc(0));
  await assert.rejects(replay.start(filename), /not a complete SK02/);
  fs.writeFileSync(filename, Buffer.alloc(PROFILE.frameBytes - 1));
  await assert.rejects(replay.start(filename), /not a complete SK02/);
  assert.equal(replay.handle, undefined);
});
