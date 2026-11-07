'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const modulePath = require.resolve('../src/core/calibration-cache.cjs');
const { ensureCalibration } = require(modulePath);
const { FORMAT } = require('../src/core/calibration-export.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const parent = path.resolve(__dirname, '../test-output');

function identity(serial = 'SYNTHETIC-CAMERA-A', firmware = 'SYNTHETIC-FIRMWARE-1') {
  const bytes = Buffer.alloc(488);
  bytes.write(serial, 0);
  bytes.write(firmware, 256);
  return { serial, protocolVersion: '2.0', deviceIdentitySha256: sha(bytes), bytes };
}

function writeBundle(folder, device) {
  const calibration = Buffer.alloc(16, 7);
  const wire = Buffer.alloc(68 + calibration.length);
  wire.writeUInt32LE(calibration.length, 64);
  calibration.copy(wire, 68);
  const files = new Map([
    ['BPM.bin', Buffer.from([1, 2])], ['KMatrix.bin', Buffer.from([3, 4])],
    ['KMatrix2.bin', Buffer.from([5, 6])], ['thermometry-wire-body.bin', wire],
    ['thermometry-calibration.bin', calibration], ['device-identity.bin', device.bytes],
    ['transactions.tsv', Buffer.from('synthetic cache test; no USB calls\n')],
  ]);
  const manifest = {
    format: FORMAT, createdUtc: '2026-11-07T20:00:00.000Z', protocolVersion: '2.0', complete: true,
    provenance: { method: 'Windows IKsControl' },
    device: { vendorId: 0x38be, productId: 0x0184, serial: device.serial, model: 'SK02' },
    files: [],
  };
  for (const [name, bytes] of files) {
    fs.writeFileSync(path.join(folder, name), bytes);
    manifest.files.push({ name, bytes: bytes.length, sha256: sha(bytes) });
  }
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

function fixture(t) {
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'calibration-cache-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(parent));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const f = { root, current: identity(), calls: { identify: 0, download: 0 }, stages: [] };
  f.options = { cacheRoot: path.join(root, 'cache'), binary: 'synthetic', device: 'synthetic', onStage: item => f.stages.push(item.stage) };
  f.dependencies = {
    identify: async () => { f.calls.identify++; return { ...f.current }; },
    download: async (_binary, _device, folder) => {
      f.calls.download++;
      writeBundle(folder, f.current);
      return { serial: f.current.serial };
    },
  };
  f.run = (options = {}, dependencies = {}) => ensureCalibration({ ...f.options, ...options }, { ...f.dependencies, ...dependencies });
  f.indexPath = device => path.join(f.options.cacheRoot, sha(device.serial + '\0' + device.deviceIdentitySha256) + '.json');
  return f;
}

test('downloads once, persists across module reload, and checks fresh identity on every call', async t => {
  const f = fixture(t);
  const first = await f.run();
  assert.equal(first.source, 'download');
  assert.equal(first.validation.radiometryValidated, false);
  assert.equal(first.files, 7);
  assert.deepEqual(f.stages, ['identity', 'download', 'saved']);
  f.stages.length = 0;
  delete require.cache[modulePath];
  const reloaded = require(modulePath).ensureCalibration;
  const second = await reloaded(f.options, f.dependencies);
  assert.equal(second.source, 'cache');
  assert.equal(second.folder, first.folder);
  assert.deepEqual(f.calls, { identify: 2, download: 1 });
  assert.deepEqual(f.stages, ['identity', 'cached']);
});

test('different serial and changed fresh firmware identity each obtain separate bundles', async t => {
  const f = fixture(t), original = { ...f.current };
  const first = await f.run();
  f.current = identity(original.serial, 'SYNTHETIC-FIRMWARE-2');
  const changed = await f.run();
  f.current = identity('SYNTHETIC-CAMERA-B', 'SYNTHETIC-FIRMWARE-2');
  const other = await f.run();
  assert.equal(new Set([first.folder, changed.folder, other.folder]).size, 3);
  assert.equal(f.calls.download, 3);
  f.current = original;
  assert.equal((await f.run()).folder, first.folder);
  assert.equal(f.calls.download, 3);
});

test('tampered tables and incomplete manifests are revalidated and replaced', async t => {
  const f = fixture(t);
  const first = await f.run();
  fs.writeFileSync(path.join(first.folder, 'KMatrix.bin'), Buffer.from([99, 99]));
  const second = await f.run();
  assert.equal(second.source, 'download');
  assert.notEqual(second.folder, first.folder);
  const manifestPath = path.join(second.folder, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.complete = false;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const third = await f.run();
  assert.equal(third.source, 'download');
  assert.notEqual(third.folder, second.folder);
  assert.equal(f.calls.download, 3);
});

test('forced refresh replaces only the index after a fully verified new bundle', async t => {
  const f = fixture(t), first = await f.run();
  const second = await f.run({ force: true });
  assert.equal(second.source, 'download');
  assert.notEqual(first.folder, second.folder);
  assert.equal((await f.run()).folder, second.folder);
  assert.ok(fs.existsSync(path.join(first.folder, 'manifest.json')));
  assert.equal(fs.readdirSync(f.options.cacheRoot).filter(name => name.endsWith('.tmp')).length, 0);
});

test('failed or partial forced refresh leaves the previous valid index usable', async t => {
  const f = fixture(t), first = await f.run();
  const index = f.indexPath(f.current), original = fs.readFileSync(index);
  await assert.rejects(f.run({ force: true }, { download: async () => { throw new Error('synthetic disconnected'); } }), /disconnected/);
  assert.deepEqual(fs.readFileSync(index), original);
  await assert.rejects(f.run({ force: true }, { download: async (_b, _d, folder) => {
    const manifest = writeBundle(folder, f.current);
    manifest.complete = false;
    fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
    return { serial: f.current.serial };
  } }));
  assert.deepEqual(fs.readFileSync(index), original);
  assert.equal((await f.run()).folder, first.folder);
});

test('camera swap or stale firmware payload between identification and download cannot be cached', async t => {
  const f = fixture(t);
  const replacement = identity('SYNTHETIC-CAMERA-B');
  await assert.rejects(f.run({}, { download: async (_b, _d, folder) => {
    writeBundle(folder, replacement);
    return { serial: replacement.serial };
  } }), /identity changed/);
  assert.equal(fs.existsSync(f.indexPath(f.current)), false);
  const stale = identity(f.current.serial, 'SYNTHETIC-FIRMWARE-OLD');
  await assert.rejects(f.run({}, { download: async (_b, _d, folder) => {
    writeBundle(folder, stale);
    return { serial: f.current.serial };
  } }), /identity changed/);
  assert.equal(fs.existsSync(f.indexPath(f.current)), false);
});

test('cache index cannot redirect validation outside its camera-specific folder', async t => {
  const f = fixture(t);
  await f.run();
  const index = f.indexPath(f.current), entry = JSON.parse(fs.readFileSync(index));
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  writeBundle(outside, f.current);
  for (const folder of ['../outside', outside, '..\\outside', 'wrong-key-ABC123']) {
    fs.writeFileSync(index, JSON.stringify({ ...entry, folder }));
    const result = await f.run();
    assert.equal(result.source, 'download');
    assert.equal(path.dirname(result.folder), f.options.cacheRoot);
  }
  assert.equal(f.calls.download, 5);
  assert.ok(fs.existsSync(path.join(outside, 'manifest.json')));
});

test('malformed index is treated as a cache miss but unverifiable fresh identity fails closed', async t => {
  const f = fixture(t);
  await f.run();
  fs.writeFileSync(f.indexPath(f.current), '{broken');
  assert.equal((await f.run()).source, 'download');
  const downloads = f.calls.download;
  for (const patch of [{serial:'unknown'}, {serial:''}, {serial:'line\nbreak'}, {protocolVersion:'1.0'}, {deviceIdentitySha256:'short'}]) {
    await assert.rejects(f.run({}, { identify: async () => ({ ...f.current, ...patch }) }), /verified camera identity/);
  }
  assert.equal(f.calls.download, downloads);
  await assert.rejects(f.run({}, { identify: async () => { throw new Error('fresh identity unavailable'); } }), /fresh identity unavailable/);
  assert.equal(f.calls.download, downloads);
});


test('temperature pipeline refreshes a legacy cache once to request the additional lens table', async t => {
  const f = fixture(t);
  const legacy = await f.run();
  const updated = await f.run({ requireVignetting: true });
  assert.equal(updated.source, 'download');
  assert.notEqual(updated.folder, legacy.folder);
  assert.equal(JSON.parse(fs.readFileSync(f.indexPath(f.current))).version, 2);
  const reused = await f.run({ requireVignetting: true });
  assert.equal(reused.source, 'cache');
  assert.equal(reused.folder, updated.folder);
  assert.equal(f.calls.download, 2);
});
