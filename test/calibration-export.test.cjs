'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validateExport, FORMAT } = require('../scripts/research/validate-calibration-export.cjs');

const expectedSerial = 'SYNTHETIC-NOT-A-CAMERA';
const parent = path.resolve(__dirname, '../test-output');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function fixture(t) {
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'calibration-validator-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(parent));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'export');
  fs.mkdirSync(directory);
  const calibration = Buffer.alloc(16, 7);
  const wire = Buffer.alloc(68 + calibration.length);
  wire.writeUInt32LE(calibration.length, 64);
  calibration.copy(wire, 68);
  const files = new Map([
    ['BPM.bin', Buffer.from([1, 2])], ['KMatrix.bin', Buffer.from([3, 4])],
    ['KMatrix2.bin', Buffer.from([5, 6])], ['thermometry-wire-body.bin', wire],
    ['thermometry-calibration.bin', calibration], ['device-identity.bin', Buffer.from(expectedSerial)],
    ['transactions.tsv', Buffer.from('synthetic test; no actual USB traffic\n')],
  ]);
  const manifest = {
    format: FORMAT, createdUtc: '2026-11-07T20:00:00.000Z', protocolVersion: '2.0',
    provenance: { method: 'Android UsbDeviceConnection.controlTransfer', sourceApk: 'synthetic-test' },
    device: { vendorId: 0x38be, productId: 0x0184, serial: expectedSerial, model: 'SK02' },
    complete: true, files: [], outcomes: {},
  };
  for (const [name, bytes] of files) {
    fs.writeFileSync(path.join(directory, name), bytes);
    manifest.files.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const save = () => fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  save();
  return { root, directory, manifest, save, files, run: () => validateExport(directory, { expectedSerial }) };
}

test('accepts a complete synthetic export without claiming radiometry or authenticity', t => {
  const f = fixture(t), report = f.run();
  assert.equal(report.valid, true, report.errors.join('\n'));
  assert.equal(report.researchOnly, true);
  assert.equal(report.radiometryValidated, false);
  assert.equal(report.thermometryWirePayloadMatches, true);
  assert.deepEqual(report.files.filter(v => v.fileType !== null).map(v => v.fileType), [4, 11, 14]);
  assert.equal(report.files.length, 7);
  assert.ok(report.files.every(v => v.valid));
});

test('requires explicit matching serial and rejects unknown identity', t => {
  const f = fixture(t);
  assert.equal(validateExport(f.directory).valid, false);
  assert.equal(validateExport(f.directory, { expectedSerial: 'OTHER-CAMERA' }).valid, false);
  for (const serial of ['', 'unknown', null, 'unavailable', 'SYNTHETIC\nINJECTED']) {
    f.manifest.device.serial = serial; f.save();
    assert.equal(f.run().valid, false);
  }
  f.manifest.device.serial = expectedSerial;
  f.manifest.device.productId = 123;
  f.save();
  assert.match(f.run().errors.join(' '), /USB identity/);
});

test('accepts the Windows exporter with the same strict identity and file contract', t => {
  const f = fixture(t);
  f.manifest.provenance = { method: 'Windows IKsControl' };
  f.save();
  assert.equal(f.run().valid, true);
});

test('rejects hash tampering and mismatched length independently', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'BPM.bin'), Buffer.from([9, 9]));
  assert.match(f.run().errors.join(' '), /SHA-256 differs/);
  fs.writeFileSync(path.join(f.directory, 'BPM.bin'), Buffer.from([1]));
  assert.match(f.run().errors.join(' '), /Actual length differs/);
});

test('rejects oversized declared and actual tables before allocating their full size', t => {
  const f = fixture(t), entry = f.manifest.files[0];
  entry.bytes = 16385; f.save();
  assert.match(f.run().errors.join(' '), /declared length/);
  entry.bytes = 2; f.save();
  fs.writeFileSync(path.join(f.directory, 'BPM.bin'), Buffer.alloc(16385));
  assert.match(f.run().errors.join(' '), /File size must be/);
});

test('rejects paths, alternate data streams, and unknown filenames', t => {
  const f = fixture(t);
  for (const name of ['../outside.bin', '..\\outside.bin', '/outside.bin', 'C:\\outside.bin', 'BPM.bin:secret', 'unknown.bin']) {
    f.manifest.files[0].name = name; f.save();
    assert.match(f.run().errors.join(' '), /Unknown file name/);
  }
});

test('rejects duplicates, missing files, and partial exports', t => {
  const f = fixture(t);
  f.manifest.files[1] = { ...f.manifest.files[0] }; f.save();
  assert.match(f.run().errors.join(' '), /Duplicate file entry/);
  f.manifest.complete = false;
  f.manifest.files.pop(); f.save();
  const report = f.run();
  assert.equal(report.valid, false);
  assert.match(report.errors.join(' '), /incomplete/);
  assert.match(report.errors.join(' '), /Missing required/);
});

test('verifies thermometry wire relationship even when both independent hashes match', t => {
  const f = fixture(t), wire = f.files.get('thermometry-wire-body.bin');
  wire.writeUInt32LE(999, 64);
  fs.writeFileSync(path.join(f.directory, 'thermometry-wire-body.bin'), wire);
  f.manifest.files.find(v => v.name === 'thermometry-wire-body.bin').sha256 = sha256(wire);
  f.save();
  assert.match(f.run().errors.join(' '), /Thermometry calibration does not match/);
  wire.writeUInt32LE(16, 64); wire[68] ^= 1;
  fs.writeFileSync(path.join(f.directory, 'thermometry-wire-body.bin'), wire);
  f.manifest.files.find(v => v.name === 'thermometry-wire-body.bin').sha256 = sha256(wire);
  f.save();
  assert.match(f.run().errors.join(' '), /Thermometry calibration does not match/);
});

test('rejects a junction/symlink escaping the export and a linked export root', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.unlinkSync(path.join(f.directory, 'BPM.bin'));
  try {
    fs.symlinkSync(outside, path.join(f.directory, 'BPM.bin'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('Host policy prevents creating symlinks/junctions'); return; }
    throw error;
  }
  assert.match(f.run().errors.join(' '), /Symlinks/);
  const linkedRoot = path.join(f.root, 'linked-export');
  fs.symlinkSync(f.directory, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(validateExport(linkedRoot, { expectedSerial }).errors.join(' '), /root must be an ordinary directory/);
});

test('rejects a file reported as a symlink before opening it', t => {
  const f = fixture(t), original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', function (filename, ...args) {
    const stat = original.call(fs, filename, ...args);
    if (filename === path.join(f.directory, 'BPM.bin')) stat.isSymbolicLink = () => true;
    return stat;
  });
  assert.match(f.run().errors.join(' '), /Symlinks/);
});

test('rejects malformed, oversized and unsupported manifests', t => {
  const f = fixture(t);
  f.manifest.format = 'unknown'; f.save();
  assert.equal(f.run().valid, false);
  fs.writeFileSync(path.join(f.directory, 'manifest.json'), '{broken');
  assert.match(f.run().errors.join(' '), /Cannot read export manifest/);
  fs.writeFileSync(path.join(f.directory, 'manifest.json'), ' '.repeat(128 * 1024 + 1));
  assert.match(f.run().errors.join(' '), /File size must be/);
});

test('requires verified protocol, known provenance and a real UTC calendar date', t => {
  const f = fixture(t);
  f.manifest.protocolVersion = null;
  f.manifest.provenance.method = 'unverified';
  f.manifest.createdUtc = '2026-02-30T12:00:00Z';
  f.save();
  const errors = f.run().errors.join(' ');
  assert.match(errors, /protocolVersion/);
  assert.match(errors, /provenance/);
  assert.match(errors, /UTC timestamp/);
});

test('CLI emits a JSON report with correct exit status and rejects omitted serial', t => {
  const f = fixture(t), cli = path.resolve(__dirname, '../scripts/research/validate-calibration-export.cjs');
  const success = spawnSync(process.execPath, [cli, f.directory, '--expected-serial', expectedSerial], { encoding: 'utf8', timeout: 5000 });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).valid, true);
  const wrong = spawnSync(process.execPath, [cli, f.directory, '--expected-serial', 'WRONG'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(wrong.status, 1);
  assert.equal(JSON.parse(wrong.stdout).valid, false);
  const missing = spawnSync(process.execPath, [cli, f.directory], { encoding: 'utf8', timeout: 5000 });
  assert.equal(missing.status, 2);
});

test('accepts optional VC with exact manifest hash and rejects tampering', t => {
  const f=fixture(t), bytes=Buffer.alloc(98304,9);
  fs.writeFileSync(path.join(f.directory,'VC.bin'),bytes);
  f.manifest.files.push({name:'VC.bin',bytes:bytes.length,sha256:sha256(bytes)});f.save();
  assert.equal(f.run().valid,true);
  assert.equal(f.run().files.find(x=>x.name==='VC.bin').fileType,5);
  fs.writeFileSync(path.join(f.directory,'VC.bin'),Buffer.alloc(98304,8));
  assert.equal(f.run().valid,false);
});
