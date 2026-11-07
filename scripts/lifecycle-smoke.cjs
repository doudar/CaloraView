// Exercises the real Electron shutdown path using an explicitly synthetic replay.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PROFILE } = require('../src/core/thermal.cjs');
(async () => {
  const output = path.resolve('test-output/lifecycle');
  fs.mkdirSync(output, { recursive: true });
  const fixture = path.join(output, 'synthetic-replay.raw');
  const frame = Buffer.alloc(PROFILE.frameBytes);
  for (let i = 0; i < frame.length; i += 2) frame.writeUInt16LE(9000 + (i % 997), i);
  fs.writeFileSync(fixture, Buffer.concat(Array(150).fill(frame)));
  const desktop = await electron.launch({ args: [path.resolve('.')], env: { ...process.env, CALORAVIEW_OUTPUT: output } });
  let closed = false;
  try {
    const page = await desktop.firstWindow();
    await page.waitForFunction(() => window.caloraview);
    // Allow initial device discovery to complete, without opening any camera.
    await page.waitForFunction(() => !document.querySelector('#replay-btn').disabled);
    await desktop.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, fixture);
    await page.click('#replay-btn');
    await page.waitForFunction(() => !document.querySelector('#record-btn').disabled);
    await page.click('#record-btn');
    await page.waitForFunction(() => document.querySelector('#record-label').textContent === 'Stop recording');
    await page.waitForTimeout(300);
    const exited = desktop.waitForEvent('close');
    await desktop.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.close(); w.close(); }).catch(() => {});
    await exited;
    closed = true;
    const folder = fs.readdirSync(output).filter(name => name.includes('-recording-')).sort().at(-1);
    const metadata = JSON.parse(fs.readFileSync(path.join(output, folder, 'session.json')));
    assert.equal(metadata.status, 'complete');
    assert(metadata.frames > 0);
    assert.equal(fs.statSync(path.join(output, folder, 'sensor.raw')).size, PROFILE.frameBytes * metadata.frames);
    assert(fs.statSync(path.join(output, folder, 'preview.mp4')).size > 100);
    console.log(JSON.stringify({ status: 'passed', repeatedClose: true, frames: metadata.frames, folder }));
  } finally { if (!closed) await desktop.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
