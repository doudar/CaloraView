// An explicitly requested normal shutter cycle, with raw evidence before/during/after.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Camera, listDevices } = require('../src/core/capture.cjs');
const { decodeFrame, makeFlatField, PROFILE } = require('../src/core/thermal.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const device = (await listDevices()).find(d => /vid_38be&pid_0184/i.test(d.id));
  if (!device) throw new Error('SK02 missing.');
  const folder = fs.mkdtempSync(path.resolve('research/shutter-'));
  const camera = new Camera();
  const frames = [], timeline = [], events = [];
  let phase = 'before', failure, helper;
  camera.on('capture-error', error => { failure = error; });
  camera.on('frame', raw => { frames.push(raw); timeline.push({ index: frames.length - 1, timestamp: Date.now(), phase }); });
  try {
    await camera.start(device.id);
    const deadline = Date.now() + 15000;
    while (frames.length < 30 && !failure && Date.now() < deadline) await sleep(100);
    if (failure) throw failure;
    if (frames.length < 30) throw new Error('Camera did not start.');
    helper = spawn(path.resolve('build/native/Caloraview.CameraControl.exe'), ['shutter-reference', device.id], { windowsHide: true });
    let buffer = '';
    helper.stdout.on('data', b => {
      buffer += b;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const event = JSON.parse(line); events.push(event);
        if (event.type === 'stage') { phase = event.stage; console.log(JSON.stringify(event)); }
      }
    });
    helper.stderr.on('data', b => process.stderr.write(b));
    const code = await new Promise((resolve, reject) => { helper.once('close', resolve); helper.once('error', reject); });
    if (code !== 0) throw new Error(JSON.stringify(events.at(-1)));
    await sleep(1500);
  } finally {
    await camera.stop();
    fs.writeFileSync(path.join(folder, 'sensor.raw'), Buffer.concat(frames));
    fs.writeFileSync(path.join(folder, 'timeline.json'), JSON.stringify({ profile: PROFILE, timeline, events }, null, 2));
  }
  const closed = events.find(e => e.type === 'stage' && e.stage === 'closed');
  if (!closed) throw new Error('No closed-shutter event.');
  const start = Date.parse(closed.timestamp);
  const references = timeline.filter(f => f.timestamp >= start + 150 && f.timestamp < start + 1000).map(f => frames[f.index]);
  if (references.length < 10) throw new Error('Insufficient closed-shutter frames.');
  const flatField = makeFlatField(references);
  const corrected = decodeFrame(frames.at(-1), { flatField, palette: 'iron' });
  fs.writeFileSync(path.join(folder, 'reference.f32'), Buffer.from(flatField.buffer));
  fs.writeFileSync(path.join(folder, 'corrected.rgba'), corrected.rgba);
  console.log(JSON.stringify({ folder, frames: frames.length, referenceFrames: references.length, stats: corrected.stats }));
})().catch(error => { console.error(error); process.exitCode = 1; });
