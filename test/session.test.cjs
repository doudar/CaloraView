'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Session, CSV_HEADER, csvRow } = require('../src/core/session.cjs');
const { PROFILE, decodeFrame } = require('../src/core/thermal.cjs');
const { ffmpegPath } = require('../src/core/capture.cjs');

function fixture(sequence = 1, mode = 'raw') {
  const raw = Buffer.alloc(PROFILE.frameBytes);
  for (let i = 0; i < raw.length; i += 2) raw.writeUInt16LE(9000 + (i % 500), i);
  return { raw, frame: { ...decodeFrame(raw), timestamp: Date.UTC(2026, 10, 7, 12, 0, 0, sequence * 40), sequence, mode } };
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caloraview-session-test-'));
  t.after(() => {
    // Test sessions contain only the files created by Session; no recursive delete.
    for (const child of fs.readdirSync(root)) {
      const folder = path.join(root, child);
      for (const name of fs.readdirSync(folder)) fs.unlinkSync(path.join(folder, name));
      fs.rmdirSync(folder);
    }
    fs.rmdirSync(root);
  });
  return root;
}

test('CSV explicitly marks uncalibrated data with blank Celsius fields and exact raw counts', () => {
  const { frame } = fixture();
  const start = frame.timestamp - 80;
  const headers = CSV_HEADER.trimEnd().split(',');
  const cells = csvRow(frame, start).trimEnd().split(',');
  assert.equal(cells.length, headers.length);
  const row = Object.fromEntries(headers.map((name, index) => [name, cells[index]]));
  assert.equal(row.timestamp_utc, new Date(frame.timestamp).toISOString());
  assert.equal(row.elapsed_ms, '80');
  assert.equal(row.source, 'raw');
  assert.equal(row.calibration_status, 'uncalibrated');
  assert.equal(row.center_c, '');
  assert.equal(row.high_c, '');
  assert.equal(row.low_c, '');
  assert.equal(Number(row.center_counts), frame.stats.center);
  assert.equal(Number(row.high_counts), frame.stats.high);
  assert.equal(Number(row.low_counts), frame.stats.low);
  assert.equal(Number(row.high_x), frame.stats.highX);
  assert.equal(Number(row.low_y), frame.stats.lowY);
});

test('CSV cannot accidentally label a caller-supplied temperature object as calibrated', () => {
  const { frame } = fixture(1, 'replay');
  frame.temperatures = { center: 25, high: 40, low: 12 };
  const row = csvRow(frame, frame.timestamp).trimEnd().split(',');
  assert.equal(row[3], 'replay');
  assert.equal(row[4], 'uncalibrated');
  assert.deepEqual(row.slice(5, 8), ['', '', '']);
});

test('sensor drift fields remain distinct from unavailable scene temperatures', () => {
  const { frame } = fixture();
  frame.sensor = { sensorRaw: 1516, sensorCounts: 1516, sensorUnits: 30.32, valid: true };
  let cells = csvRow(frame, frame.timestamp).trimEnd().split(',');
  assert.deepEqual(cells.slice(5, 8), ['', '', '']);
  assert.deepEqual(cells.slice(15, 18), ['1516', '1516', '30.32']);
  frame.sensor = { sensorRaw: 0, sensorCounts: null, sensorUnits: null, valid: false };
  cells = csvRow(frame, frame.timestamp).trimEnd().split(',');
  assert.deepEqual(cells.slice(15, 18), ['0', '', '']);
});

test('CSV-only sessions finalize metadata, create unique directories, and stop accepting frames', async t => {
  const root = tempRoot(t);
  const session = new Session(root, { source: 'SK02', palette: 'inferno' });
  const another = new Session(root, { source: 'SK02' });
  assert.notEqual(session.folder, another.folder);
  const { raw, frame } = fixture();
  session.append(raw, frame);
  const folder = await session.stop();
  session.append(raw, frame);
  assert.equal(await session.stop(), folder);
  await another.stop();
  const metadata = JSON.parse(fs.readFileSync(path.join(folder, 'session.json'), 'utf8'));
  assert.equal(metadata.frames, 1);
  assert.equal(metadata.status, 'complete');
  assert.equal(metadata.calibration, 'unavailable');
  assert.equal(metadata.detectorUnit, 'counts');
  assert.deepEqual(metadata.profile, PROFILE);
  assert.equal(metadata.preview.palette, 'inferno');
  assert.equal(metadata.preview.cropStatus, 'apk-routine-verified-runtime-unverified');
  const lines = fs.readFileSync(path.join(folder, 'measurements.csv'), 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0] + '\n', CSV_HEADER);
  assert.ok(!fs.existsSync(path.join(folder, 'sensor.raw')));
  assert.ok(!fs.existsSync(path.join(folder, 'preview.mp4')));
});

test('interrupted sessions record a reason and preserve visual flat field separately from temperature calibration', async t => {
  const root = tempRoot(t);
  const flatField = new Float32Array(PROFILE.imageWidth * PROFILE.imageHeight).fill(12345);
  const session = new Session(root, { flatField });
  const folder = await session.stop('Camera disconnected');
  const metadata = JSON.parse(fs.readFileSync(path.join(folder, 'session.json'), 'utf8'));
  assert.equal(metadata.status, 'interrupted');
  assert.equal(metadata.error, 'Camera disconnected');
  assert.equal(session.finalError, 'Camera disconnected');
  assert.equal(metadata.preview.flatField, true);
  assert.equal(metadata.calibration, 'unavailable');
  assert.deepEqual(fs.readFileSync(path.join(folder, 'flat-field.f32')), Buffer.from(flatField.buffer));
});

test('concurrent stop callers share finalization and wait until the encoder finishes', async t => {
  const root = tempRoot(t);
  const session = new Session(root);
  let releaseEncoder;
  let endCalls = 0;
  session.encoder = { stdin: { end() { endCalls++; } }, kill() { throw new Error('Unexpected encoder timeout'); } };
  session.encoderDone = new Promise(resolve => { releaseEncoder = resolve; });
  const first = session.stop();
  const second = session.stop('Device removed during finalization');
  assert.equal(first, second);
  let finished = false;
  second.then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(endCalls, 1);
  session.encoderExit = 0;
  releaseEncoder(0);
  assert.equal(await first, session.folder);
  assert.equal(await second, session.folder);
  const metadata = JSON.parse(fs.readFileSync(path.join(session.folder, 'session.json'), 'utf8'));
  assert.equal(metadata.status, 'interrupted');
  assert.equal(metadata.error, 'Device removed during finalization');
});

test('failed constructor closes its files even when writing metadata fails', t => {
  const root = tempRoot(t);
  const originalOpen = fs.openSync;
  const originalWriteFile = fs.writeFileSync;
  const descriptors = [];
  t.mock.method(fs, 'openSync', function (...args) {
    const fd = originalOpen.apply(this, args);
    descriptors.push(fd);
    return fd;
  });
  t.mock.method(fs, 'writeFileSync', function (filename, ...args) {
    if (String(filename).endsWith('session.json')) throw new Error('Simulated metadata disk failure');
    return originalWriteFile.call(this, filename, ...args);
  });
  assert.throws(() => new Session(root, { video: true }), /Simulated metadata disk failure/);
  assert.equal(descriptors.length, 3);
  for (const fd of descriptors) assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
});

test('partial disk writes are rolled back and final metadata marks interrupted capture', async t => {
  const root = tempRoot(t);
  const session = new Session(root);
  const { raw, frame } = fixture();
  session.append(raw, frame);
  const before = fs.readFileSync(path.join(session.folder, 'measurements.csv'));
  const originalWrite = fs.writeSync;
  let partialWritten = false;
  const mock = t.mock.method(fs, 'writeSync', function (fd, buffer, offset, length, position) {
    if (fd === session.csv) {
      if (partialWritten) throw new Error('Simulated full disk');
      partialWritten = true;
      return originalWrite.call(this, fd, buffer, offset, 5, position);
    }
    return originalWrite.apply(this, arguments);
  });
  assert.throws(() => session.append(raw, { ...fixture(2).frame, timestamp: frame.timestamp + 500 }), /Simulated full disk/);
  mock.mock.restore();
  assert.equal(session.frames, 1);
  assert.deepEqual(fs.readFileSync(path.join(session.folder, 'measurements.csv')), before);
  assert.throws(() => session.append(raw, frame), /Simulated full disk/);
  await session.stop();
  assert.equal(session.finalError, 'Simulated full disk');
  const metadata = JSON.parse(fs.readFileSync(path.join(session.folder, 'session.json'), 'utf8'));
  assert.equal(metadata.status, 'interrupted');
  assert.equal(metadata.frames, 1);
});

let binary;
try { binary = ffmpegPath(); } catch { /* Optional integration dependency. */ }
const encoderAvailable = !!binary && (fs.existsSync(binary) || !!process.env.CALORAVIEW_FFMPEG);

test('real FFmpeg recording preserves every raw byte and finalizes a playable MP4 with CSV', { skip: !encoderAvailable, timeout: 30000 }, async t => {
  const root = tempRoot(t);
  const session = new Session(root, { video: true, source: 'Synthetic test fixture' });
  const errors = [];
  session.on('session-error', error => errors.push(error));
  const first = fixture(1), second = fixture(2), third = fixture(3);
  for (const { raw, frame } of [first, second, third]) session.append(raw, frame);
  const folder = await session.stop();
  assert.deepEqual(errors, []);
  assert.equal(session.finalError, undefined);
  assert.deepEqual(fs.readFileSync(path.join(folder, 'sensor.raw')), Buffer.concat([first.raw, second.raw, third.raw]));
  assert.equal(fs.readFileSync(path.join(folder, 'measurements.csv'), 'utf8').trimEnd().split('\n').length, 2);
  const metadata = JSON.parse(fs.readFileSync(path.join(folder, 'session.json'), 'utf8'));
  assert.equal(metadata.frames, 3);
  assert.equal(metadata.measurementRows, 1);
  assert.equal(metadata.status, 'complete');
  const probe = spawnSync(binary, ['-hide_banner', '-v', 'error', '-i', path.join(folder, 'preview.mp4'), '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
});

test('CSV records proven pipeline temperatures and their own extrema without replacing raw extrema', () => {
  const { frame } = fixture();
  frame.calibration = { status: 'factory-calibrated', serial: 'synthetic-test', algorithm: 'synthetic-fixture' };
  frame.temperatures = { center: 25.125, high: 40.25, low: 12.75, highX: 70, highY: 60, lowX: 10, lowY: 20 };
  const headers = CSV_HEADER.trimEnd().split(',');
  const parse = () => Object.fromEntries(csvRow(frame, frame.timestamp).trimEnd().split(',').map((value, index) => [headers[index], value]));
  const row = parse();
  assert.equal(row.calibration_status, 'factory-calibrated');
  assert.equal(row.center_c, '25.125');
  assert.equal(row.high_c, '40.25');
  assert.equal(Number(row.center_f), 25.125 * 9 / 5 + 32);
  assert.equal(Number(row.high_f), 40.25 * 9 / 5 + 32);
  assert.equal(row.low_c, '12.75');
  assert.equal(row.high_temperature_x, '70');
  assert.equal(row.low_temperature_y, '20');
  assert.equal(Number(row.high_x), frame.stats.highX);
  for (const invalid of [{ ...frame.temperatures, high: NaN }, { ...frame.temperatures, low: 26 }, { ...frame.temperatures, highX: 256 }]) {
    const valid = frame.temperatures;
    frame.temperatures = invalid;
    assert.equal(parse().center_c, '');
    assert.equal(parse().calibration_status, 'uncalibrated');
    frame.temperatures = valid;
  }
});

function csvRecords(session) {
  const lines = fs.readFileSync(path.join(session.folder, 'measurements.csv'), 'utf8').trimEnd().split('\n');
  const names = lines.shift().split(',');
  return lines.map(line => Object.fromEntries(line.split(',').map((value, i) => [names[i], value])));
}
function sampledFrame(index, ms, { fresh = true, sampleSequence = index, wall = 1700000000000 + ms } = {}) {
  const data = fixture(index);
  data.frame.timestamp = wall + 10;
  data.frame.measurementSample = { fresh, timestamp: wall, monotonicMs: ms, sequence: sampleSequence };
  data.frame.calibration = { status: 'factory-calibrated', serial: 'synthetic-test', algorithm: 'synthetic-fixture' };
  data.frame.temperatures = { center: 25, high: 30, low: 20, highX: 1, highY: 2, lowX: 3, lowY: 4 };
  return data;
}

test('2 Hz measurement CSV ignores held10 Hz preview values and records fresh sample identity', async t => {
  const session = new Session(tempRoot(t));
  for (let i = 0; i < 20; i++) {
    const { raw, frame } = sampledFrame(i + 1, i * 100, { fresh: i % 5 === 0 });
    session.append(raw, frame);
  }
  await session.stop();
  const rows = csvRecords(session);
  assert.equal(session.frames, 20);
  assert.equal(session.measurementRows, 4);
  assert.deepEqual(rows.map(row => Number(row.measurement_sample_sequence)), [1,6,11,16]);
  assert.deepEqual(rows.map(row => Number(row.measurement_sample_monotonic_ms)), [0,500,1000,1500]);
  assert.equal(rows[0].timestamp_utc, new Date(1700000000000).toISOString());
  assert.ok(rows.every(row => row.center_c === '25'));
  const meta = JSON.parse(fs.readFileSync(path.join(session.folder, 'session.json')));
  assert.equal(meta.frames, 20); assert.equal(meta.measurementRows, 4); assert.equal(meta.logFrequencyHz, 2);
});

test('fresh2 Hz jitter is retained and lower logging rates keep anchored deadlines', async t => {
  const root = tempRoot(t);
  for (const frequency of [2,1,.5,.2]) {
    const session = new Session(root, { logFrequencyHz: frequency });
    for (let i = 0; i <= 20; i++) {
      const { raw, frame } = sampledFrame(i + 1, i * 500 + (i % 2 ? -20 : 0));
      session.append(raw, frame);
    }
    await session.stop();
    const rows = csvRecords(session);
    assert.equal(rows.length, frequency * 10 + 1);
    assert.equal(session.frames, 21);
    assert.equal(rows.at(-1).measurement_sample_monotonic_ms, '10000');
  }
  assert.throws(() => new Session(root, { logFrequencyHz: 3 }), /frequency/);
});

test('fresh invalid attempts produce blank gaps and stale/rolled-back samples are not duplicated', async t => {
  const session = new Session(tempRoot(t));
  const inputs = [sampledFrame(1,0), sampledFrame(2,500), sampledFrame(3,600,{fresh:false}),
    sampledFrame(4,1000,{sampleSequence:2}), sampledFrame(5,400), sampledFrame(6,1500,{wall:1699999999000})];
  inputs[1].frame.temperatures = null;
  inputs[1].frame.calibration.status = 'unavailable';
  for (const { raw, frame } of inputs) session.append(raw, frame);
  await session.stop();
  const rows = csvRecords(session);
  assert.deepEqual(rows.map(row => row.center_c), ['25','','25']);
  assert.deepEqual(rows.map(row => row.measurement_sample_sequence), ['1','2','6']);
  assert.ok(Number(rows[2].elapsed_ms) > Number(rows[1].elapsed_ms));
  assert.ok(rows[2].timestamp_utc < rows[1].timestamp_utc); // Wall clock rollback does not change cadence.
});

test('legacy frames obey the configured cadence and ignore reversed timestamps', async t => {
  const session = new Session(tempRoot(t), { logFrequencyHz: 1 });
  const { raw, frame } = fixture();
  for (const ms of [0,100,500,900,1000,800,1100,2000]) session.append(raw, { ...frame, timestamp: frame.timestamp + ms });
  await session.stop();
  assert.equal(session.frames, 8);
  assert.equal(session.measurementRows, 3);
  assert.ok(csvRecords(session).every(row => row.measurement_sample_sequence === ''));
});

test('environment columns are explicit configured inputs, with missing or invalid values blank', () => {
  const { frame } = fixture();
  const names = CSV_HEADER.trimEnd().split(',');
  const parse = () => Object.fromEntries(csvRow(frame, frame.timestamp).trimEnd().split(',').map((v,i) => [names[i],v]));
  assert.equal(parse().room_temperature_c, ''); assert.equal(parse().relative_humidity_percent, '');
  frame.calibration = { environment: { ambientC: 20, humidityPercent: 60 } };
  assert.equal(parse().room_temperature_c, '20'); assert.equal(parse().room_temperature_f, '68');
  assert.equal(parse().relative_humidity_percent, '60');
  frame.environment = { ambientC: 0, humidityPercent: 0 };
  assert.equal(parse().room_temperature_c, '0'); assert.equal(parse().room_temperature_f, '32');
  assert.equal(parse().relative_humidity_percent, '0');
  frame.environment = { ambientC: NaN, humidityPercent: 101 };
  assert.equal(parse().room_temperature_c, ''); assert.equal(parse().room_temperature_f, '');
  assert.equal(parse().relative_humidity_percent, '');
});

test('CSV write failure rolls back raw bytes, row count and measurement cadence together', async t => {
  const session = new Session(tempRoot(t));
  session.raw = fs.openSync(path.join(session.folder, 'sensor.raw'), 'wx');
  const first = sampledFrame(1,0), held = sampledFrame(2,100,{fresh:false}), next = sampledFrame(3,500);
  session.append(first.raw, first.frame); session.append(held.raw, held.frame);
  const state = { ...session.measurementState };
  const original = fs.writeSync;
  const mocked = t.mock.method(fs,'writeSync',function(fd,...args) {
    if (fd === session.csv) throw new Error('sample write failure');
    return original.call(this,fd,...args);
  });
  assert.throws(() => session.append(next.raw,next.frame), /sample write failure/);
  mocked.mock.restore();
  assert.equal(session.frames,2); assert.equal(session.measurementRows,1);
  assert.deepEqual(session.measurementState,state);
  assert.equal(fs.statSync(path.join(session.folder,'sensor.raw')).size,PROFILE.frameBytes*2);
  assert.deepEqual(fs.readFileSync(path.join(session.folder,'sensor.raw')),Buffer.concat([first.raw,held.raw]));
  await session.stop();
  assert.equal(csvRecords(session).length,1);
});

function fakeVideo(t, preview = { width:256,height:192,fps:25 }) {
  const session = new Session(tempRoot(t), { preview });
  session.raw = fs.openSync(path.join(session.folder,'sensor.raw'),'wx');
  session.previewCsv = fs.openSync(path.join(session.folder,'preview-frames.csv'),'wx');
  const header = require('../src/core/session.cjs').PREVIEW_CSV_HEADER;
  fs.writeSync(session.previewCsv,header); session.previewCsvBytes=Buffer.byteLength(header);
  const encoded=[];
  session.encoder={stdin:{writableLength:0,write(bytes){encoded.push(Buffer.from(bytes));return true;},end(){}},kill(){throw Error('Unexpected kill');}};
  session.encoderDone=Promise.resolve(0);session.encoderExit=0;
  return {session,encoded};
}
function sourceFrame(sequence) {
  const item=fixture(sequence);item.frame.captureMonotonicMs=sequence*40;
  item.frame.displayTransform={method:'ai-super-resolution',model:'test-model',provider:'test-provider'};
  return item;
}
function previewRows(session) {return fs.readFileSync(path.join(session.folder,'preview-frames.csv'),'utf8').trimEnd().split('\n').slice(1).map(line=>line.split(','));}

test('independent25raw/15enhanced images retain all evidence and encode25 truthful CFR slots', async t=>{
  const {session,encoded}=fakeVideo(t);const frames=Array.from({length:25},(_,i)=>sourceFrame(i+1));
  for(const {raw,frame}of frames)session.append(raw,{...frame,width:1,height:1,rgba:null},{videoFrame:false});
  assert.equal(encoded.length,0);
  const indices=[1,3,4,6,8,9,11,13,14,16,18,19,21,23,25];
  for(const sequence of indices)assert.equal(session.appendVideo(frames[sequence-1].frame),true);
  await session.stop();
  assert.equal(session.frames,25);assert.equal(session.videoFrames,25);assert.equal(session.uniquePreviewFrames,15);
  assert.deepEqual(fs.readFileSync(path.join(session.folder,'sensor.raw')),Buffer.concat(frames.map(x=>x.raw)));
  const rows=previewRows(session);assert.equal(rows.length,25);assert.equal(rows.filter(row=>row[5]==='1').length,10);
  rows.forEach((row,i)=>{assert.equal(Number(row[0]),i+1);assert.equal(row[1],row[2]);assert.equal(row[3],new Date(frames[Number(row[1])-1].frame.timestamp).toISOString());assert.deepEqual(encoded[i],frames[Number(row[1])-1].frame.rgba);});
  assert.equal(rows[1][1],'1');assert.equal(rows[1][5],'1');assert.equal(rows[2][1],'3');
  assert.equal(rows[24][4],'960');assert.equal(rows[0][6],'"ai-super-resolution"');
  const meta=JSON.parse(fs.readFileSync(path.join(session.folder,'session.json')));
  assert.equal(meta.videoFrames,25);assert.equal(meta.uniquePreviewFrames,15);assert.equal(meta.videoStart.rawFrame,1);
  assert.equal(meta.preview.fps,25);
});

test('asynchronous previews reject before-session, duplicates, older results and geometry changes', async t=>{
  const {session,encoded}=fakeVideo(t);const a=sourceFrame(5),b=sourceFrame(6),c=sourceFrame(7);
  assert.equal(session.appendVideo(a.frame),false);
  for(const item of[a,b,c])session.append(item.raw,item.frame,{videoFrame:false});
  assert.equal(session.appendVideo(b.frame),true);assert.equal(session.appendVideo(b.frame),false);assert.equal(session.appendVideo(a.frame),false);
  assert.throws(()=>session.appendVideo({...c.frame,width:192,height:256}),/preview frame/);
  assert.throws(()=>session.appendVideo({...c.frame,timestamp:c.frame.timestamp+1}),/source timestamp/);
  assert.throws(()=>session.appendVideo({...c.frame,captureMonotonicMs:999}),/monotonic/);
  assert.equal(session.appendVideo(c.frame),true);assert.equal(encoded.length,2);await session.stop();
  assert.equal(session.appendVideo(c.frame),false);assert.equal(session.frames,3);
});

test('preview gaps are bounded and source mapping retains only512 raw frames', async t=>{
  const {session}=fakeVideo(t);const first=sourceFrame(1),last=sourceFrame(60);
  session.append(first.raw,first.frame,{videoFrame:false});session.appendVideo(first.frame);
  session.append(last.raw,last.frame,{videoFrame:false});
  assert.throws(()=>session.appendVideo(last.frame),/more than2 seconds/);assert.equal(session.videoFrames,1);
  for(let i=61;i<574;i++){const frame={...last.frame,sequence:i,timestamp:last.frame.timestamp+i*40,captureMonotonicMs:i*40};session.append(last.raw,frame,{videoFrame:false});}
  assert.equal(session.rawFrameMap.size,512);assert.equal(session.appendVideo(first.frame),false);
  await session.stop();
});

test('preview manifest failure rolls back only incomplete video row while retained raw remains complete', async t=>{
  const {session,encoded}=fakeVideo(t);const a=sourceFrame(1),b=sourceFrame(2);
  session.append(a.raw,a.frame,{videoFrame:false});session.appendVideo(a.frame);session.append(b.raw,b.frame,{videoFrame:false});
  const bytes=fs.readFileSync(path.join(session.folder,'preview-frames.csv')),write=fs.writeSync;
  const mock=t.mock.method(fs,'writeSync',function(fd,...args){if(fd===session.previewCsv)throw Error('preview manifest disk failure');return write.call(this,fd,...args);});
  assert.throws(()=>session.appendVideo(b.frame),/preview manifest disk failure/);mock.mock.restore();
  assert.equal(session.frames,2);assert.equal(session.videoFrames,1);assert.equal(encoded.length,1);
  assert.equal(fs.statSync(path.join(session.folder,'sensor.raw')).size,PROFILE.frameBytes*2);
  assert.deepEqual(fs.readFileSync(path.join(session.folder,'preview-frames.csv')),bytes);await session.stop();
  assert.equal(session.finalError,'preview manifest disk failure');
});


test('session preserves configured environment independently of temperature availability', async t => {
  const root = tempRoot(t);
  const environment = { emissivityPreset: 'paint', emissivity: .93, distanceMeters: 3.048,
    ambientC: 21.123456789, reflectedC: 19.234567891, humidityPercent: 47 };
  const expected = structuredClone(environment);
  const session = new Session(root, { calibration: null, environment });
  environment.emissivity = .2;
  environment.emissivityPreset = 'custom';
  await session.stop();
  const saved = JSON.parse(fs.readFileSync(path.join(session.folder, 'session.json'), 'utf8'));
  assert.equal(saved.calibration, 'unavailable');
  assert.equal(saved.factoryCalibration, null);
  assert.equal(saved.environmentSource, 'configured');
  assert.deepEqual(saved.environment, expected);
  assert.deepEqual(session.metadata.environment, expected);
});

test('session environment falls back to calibration provenance for existing callers', async t => {
  const environment = { emissivity: .91, distanceMeters: .9144, ambientC: 20, reflectedC: 20, humidityPercent: 60 };
  const expected = structuredClone(environment);
  const session = new Session(tempRoot(t), { calibration: { status: 'factory-calibrated', environment } });
  environment.ambientC = 99;
  assert.deepEqual(session.metadata.environment, expected);
  await session.stop();
  const saved = JSON.parse(fs.readFileSync(path.join(session.folder, 'session.json'), 'utf8'));
  assert.deepEqual(saved.environment, expected);
});

test('automatic reflection exports the effective estimate separately from the saved manual value', async t => {
  const configured={emissivity:.85,distanceMeters:.9144,ambientC:22,reflectedC:20,reflectedManualOverride:false,humidityPercent:40};
  const effective={...configured,reflectedC:31.8399658203125};
  const session=new Session(tempRoot(t),{environment:effective,configuredEnvironment:configured});
  const {frame}=fixture();frame.environment=effective;
  const names=CSV_HEADER.trimEnd().split(',');
  const row=Object.fromEntries(csvRow(frame,frame.timestamp).trimEnd().split(',').map((value,i)=>[names[i],value]));
  assert.equal(Number(row.reflected_temperature_c),effective.reflectedC);
  assert.equal(Number(row.reflected_temperature_f),effective.reflectedC*9/5+32);
  assert.equal(row.reflected_temperature_source,'camera-initial-estimate');
  await session.stop();
  const saved=JSON.parse(fs.readFileSync(path.join(session.folder,'session.json')));
  assert.deepEqual(saved.environment,effective);
  assert.deepEqual(saved.configuredEnvironment,configured);
  assert.equal(saved.environmentSource,'configured-with-automatic-reflection');
  frame.environment={...configured,reflectedC:null};
  const pending=csvRow(frame,frame.timestamp).trimEnd().split(',');
  assert.deepEqual(pending.slice(-3),['','','']);
});
