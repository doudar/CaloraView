// Explicit hardware check: captures a short real recording, never changes camera settings.
const path = require('node:path');
const fs = require('node:fs');
const { Camera, listDevices } = require('../src/core/capture.cjs');
const { decodeFrame } = require('../src/core/thermal.cjs');
const { Session } = require('../src/core/session.cjs');
(async () => {
  const devices = await listDevices();
  const target = devices.find(d => /vid_38be&pid_0184/i.test(d.id)) || devices.find(d => d.name === 'UVC Camera');
  if (!target) throw new Error('AccuMEMS SK02 not found.');
  const camera = new Camera();
  const session = new Session(path.resolve('test-output'), { video: true, source: target.name });
  let count = 0;
  let failure;
  const completion = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No complete hardware capture within 20 seconds.')), 20000);
    camera.on('capture-error', reject);
    session.on('session-error', reject);
    camera.on('frame', raw => {
      if (count >= 75) return;
      const decoded = decodeFrame(raw);
      const frame = { ...decoded, timestamp: Date.now(), sequence: ++count, mode: 'raw' };
      session.append(raw, frame);
      if (count === 1) console.log(JSON.stringify({ device: target.name, firstFrameStats: decoded.stats, temperatures: decoded.temperatures }));
      if (count >= 75) { clearTimeout(timeout); resolve(); }
    });
  });
  try { await camera.start(target.id); await completion; }
  catch (error) { failure = error; }
  finally { await camera.stop(); await session.stop(failure?.message); }
  if (failure) throw failure;
  if (session.finalError) throw new Error(session.finalError);
  console.log(JSON.stringify({ frames: count, folder: session.folder, files: fs.readdirSync(session.folder) }));
})().catch(error => { console.error(error); process.exitCode = 1; });
