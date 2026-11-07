'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Session } = require('../src/core/session.cjs');
const { PROFILE, decodeFrame } = require('../src/core/thermal.cjs');
const { createRadiometry } = require('../src/core/radiometry.cjs');
const { transformPreview } = require('../src/core/display-transform.cjs');
const { ffmpegPath } = require('../src/core/capture.cjs');

function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caloraview-hd-session-'));
  t.after(() => {
    for (const folder of fs.readdirSync(root)) {
      for (const name of fs.readdirSync(path.join(root, folder))) fs.unlinkSync(path.join(root, folder, name));
      fs.rmdirSync(path.join(root, folder));
    }
    fs.rmdirSync(root);
  });
  return root;
}
function fixture(sequence, available = true) {
  // Invented calibration coefficients exercise the real portable conversion;
  // no vendor data or physical accuracy assertion is included in this fixture.
  const calibration = Buffer.alloc(14336), metadata = Buffer.alloc(1024);
  calibration.writeUInt32LE(0x404, 0); calibration.writeUInt32LE(14336, 4); calibration.writeUInt32LE(83, 8);
  calibration.write('HM-TJ12-3AAY1F', 16, 'ascii');
  for (const [offset, value] of [[0x27f4,1],[0x27ec,.02],[0x50,-100],[0x64,500],[0x270,25],[0x464,20],
    [0xd20,1],[0x698,100000],[0x69c,1400],[0x6a4,1],[0x28a8,-100],[0x2898,100],[0x21ac,1],[0x21b0,1100],[0x21b4,.6]]) calibration.writeFloatLE(value, offset);
  metadata.writeUInt16LE(1250, 2); metadata.writeUInt16LE(1, 10); metadata.writeUInt16LE(192, 16); metadata.writeUInt16LE(256, 18);
  if (!available) metadata.writeUInt16LE(1, 12);
  const corrected = new Uint16Array(49152).fill(8192);
  corrected[40 * 256 + 80] = 9000; corrected[20 * 256 + 10] = 8000;
  const radiometry = createRadiometry(calibration, { serial: 'synthetic-hd-test' });
  const raw = Buffer.alloc(PROFILE.frameBytes);
  for (let i = 0; i < raw.length; i++) raw[i] = (i + sequence * 13) & 255;
  const native = { ...decodeFrame(raw, { factoryPlane: corrected }), ...radiometry.evaluate(corrected, metadata),
    timestamp: Date.UTC(2026, 10, 7, 12, 0, 0, sequence * 500), sequence, mode: 'raw' };
  return { raw, native, frame: transformPreview(native, { resolution: 'enhanced', rotation: 90 }) };
}
let binary;
try { binary = ffmpegPath(); } catch { /* Integration dependency is optional. */ }
const encoderAvailable = !!binary && (fs.existsSync(binary) || !!process.env.CALORAVIEW_FFMPEG);

test('HD90 recording preserves384x512 geometry, raw bytes, native temperature coordinates and reference gaps', { skip: !encoderAvailable, timeout: 30000 }, async t => {
  const first = fixture(1), reference = fixture(2, false), resumed = fixture(3);
  assert.ok(first.frame.temperatures); assert.equal(reference.frame.temperatures, null);
  const session = new Session(rootFor(t), { video: true, source: 'Synthetic corrected detector', calibration: first.frame.calibration,
    preview: { width:384,height:512,resolution:'enhanced',rotation:90 } });
  const errors = []; session.on('session-error', error => errors.push(error));
  session.append(first.raw, first.frame);
  if (session.encoder.stdin.writableNeedDrain) await new Promise(resolve => session.encoder.stdin.once('drain', resolve));
  session.append(reference.raw, reference.frame);
  if (session.encoder.stdin.writableNeedDrain) await new Promise(resolve => session.encoder.stdin.once('drain', resolve));
  session.addReference({ id:'synthetic-reference-2',source:'synthetic-test',frames:16 }, 'synthetic-reference-folder');
  session.append(resumed.raw, resumed.frame);
  await session.stop();
  assert.deepEqual(errors, []); assert.equal(session.finalError, undefined);
  assert.deepEqual(fs.readFileSync(path.join(session.folder, 'sensor.raw')), Buffer.concat([first.raw, reference.raw, resumed.raw]));
  const metadata = JSON.parse(fs.readFileSync(path.join(session.folder, 'session.json'), 'utf8'));
  assert.equal(metadata.status, 'complete'); assert.equal(metadata.frames, 3); assert.equal(metadata.measurementRows, 3);
  assert.deepEqual([metadata.preview.width,metadata.preview.height,metadata.preview.rotation], [384,512,90]);
  assert.equal(metadata.referenceHistory[0].beforeFrame, 3);
  const lines = fs.readFileSync(path.join(session.folder, 'measurements.csv'), 'utf8').trimEnd().split('\n');
  const headers = lines[0].split(',');
  const rows = lines.slice(1).map(line => Object.fromEntries(line.split(',').map((value, i) => [headers[i],value])));
  assert.deepEqual(rows.map(row => row.calibration_status), ['factory-calibrated','uncalibrated','factory-calibrated']);
  assert.equal(Number(rows[0].center_c), first.native.temperatures.center);
  assert.equal(rows[0].high_temperature_x, '80'); assert.equal(rows[0].high_temperature_y, '40');
  assert.equal(rows[0].low_temperature_x, '10'); assert.equal(rows[0].low_temperature_y, '20');
  assert.notEqual(first.frame.displayMarkers.high.x, first.native.temperatures.highX);
  assert.deepEqual([rows[1].center_c, rows[1].high_c, rows[1].low_c], ['','','']);
  assert.equal(Number(rows[2].center_c), resumed.native.temperatures.center);
  // FFmpeg reports decoded dimensions and returns exactly one full RGBA frame.
  const decoded = spawnSync(binary, ['-hide_banner','-i',path.join(session.folder,'preview.mp4'),'-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],
    { windowsHide:true,timeout:10000,maxBuffer:2*1024*1024 });
  assert.equal(decoded.status, 0, decoded.stderr?.toString() || decoded.error?.message);
  assert.match(decoded.stderr.toString(), /384x512/);
  assert.equal(decoded.stdout.length, 384 * 512 * 4);
});

test('a same-byte-length landscape frame cannot enter a frozen portrait recording', { skip: !encoderAvailable, timeout:30000 }, async t => {
  const item = fixture(1), session = new Session(rootFor(t), { video:true,preview:{width:384,height:512,resolution:'enhanced',rotation:90} });
  session.on('session-error', () => {});
  try {
    session.append(item.raw, item.frame);
    const wrong = { ...item.frame,width:512,height:384 };
    assert.throws(() => session.append(item.raw, wrong), /dimensions|geometry|preview frame/i);
    assert.equal(session.frames, 1);
  } finally { await session.stop(); }
});
