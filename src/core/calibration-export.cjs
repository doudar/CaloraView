'use strict';

// Bundle integrity only. Successful validation never enables radiometry.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FORMAT = 'accuheat-calibration-export-v1';
const TABLES = new Map([
  ['VC.bin', { kind: 'vignetting-correction', fileType: 5, min: 1, max: 98304, optional: true }],
  ['BPM.bin', { kind: 'bad-pixel-map', fileType: 4, min: 1, max: 16384 }],
  ['KMatrix.bin', { kind: 'pixel-gain-matrix', fileType: 11, min: 1, max: 98304 }],
  ['KMatrix2.bin', { kind: 'pixel-gain-matrix-2', fileType: 14, min: 1, max: 98304 }],
  ['thermometry-wire-body.bin', { kind: 'thermometry-wire-body', selector: 3, subcommand: 14, min: 69, max: 4 * 1024 * 1024 }],
  ['thermometry-calibration.bin', { kind: 'thermometry-calibration', selector: 3, subcommand: 14, min: 1, max: 4 * 1024 * 1024 - 68 }],
  ['device-identity.bin', { kind: 'device-identity', selector: 1, subcommand: 1, min: 1, max: 512 }],
  ['transactions.tsv', { kind: 'transaction-log', min: 1, max: 16 * 1024 * 1024 }],
]);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validSerial(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value)
    && !/^(unknown|unavailable|null|undefined|none|n\/a)$/i.test(value);
}

function validUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19);
}

function readBoundedFile(root, name, maximum) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(name) || name === '.' || name === '..') {
    throw new Error('Only direct, ordinary file basenames are allowed');
  }
  const candidate = path.join(root, name);
  const before = fs.lstatSync(candidate);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('Symlinks and non-regular files are rejected');
  const real = fs.realpathSync(candidate);
  if (path.dirname(real) !== root) throw new Error('File resolves outside the export directory');
  const fd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('File changed while opening');
    if (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maximum) throw new Error(`File size must be 1..${maximum} bytes`);
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const read = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!read) throw new Error('File became shorter while reading');
      offset += read;
    }
    const after = fs.fstatSync(fd);
    const linked = fs.lstatSync(candidate);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || linked.isSymbolicLink()
      || linked.ino !== stat.ino || linked.dev !== stat.dev || fs.realpathSync(candidate) !== real) {
      throw new Error('File changed while reading');
    }
    return data;
  } finally { fs.closeSync(fd); }
}

function validateExport(directory, { expectedSerial } = {}) {
  const report = {
    researchOnly: true, valid: false, complete: false, radiometryValidated: false,
    expectedSerial: expectedSerial ?? null, device: null, files: [], errors: [],
    limitations: ['Checks local integrity and claimed identity, not authenticity, calibration accuracy, or compatibility with the live camera pipeline.'],
  };
  const fail = message => report.errors.push(message);
  if (!validSerial(expectedSerial)) {
    fail('An explicit, non-placeholder expected serial is required.');
    return report;
  }
  let root, manifest;
  try {
    const location = path.resolve(directory);
    const stat = fs.lstatSync(location);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Export root must be an ordinary directory, not a symlink');
    root = fs.realpathSync(location);
    const raw = readBoundedFile(root, 'manifest.json', 128 * 1024);
    manifest = JSON.parse(raw.toString('utf8'));
    report.manifestSha256 = crypto.createHash('sha256').update(raw).digest('hex');
  } catch (error) {
    fail(`Cannot read export manifest: ${error.message}`);
    return report;
  }
  if (!plainObject(manifest)) { fail('Manifest must be an object.'); return report; }
  if (manifest.format !== FORMAT) fail(`Expected manifest format ${FORMAT}.`);
  if (manifest.protocolVersion !== '2.0') fail('Verified protocolVersion 2.0 is required.');
  if (!validUtc(manifest.createdUtc)) fail('createdUtc must be a valid UTC timestamp.');
  if (!plainObject(manifest.provenance) || !['Android UsbDeviceConnection.controlTransfer', 'Windows IKsControl'].includes(manifest.provenance.method)) fail('Unrecognized export provenance method.');
  if (typeof manifest.complete !== 'boolean') fail('complete must be boolean.');
  report.complete = manifest.complete === true;
  if (!report.complete) fail('Export is incomplete; available files are checked but the bundle is not accepted.');
  const device = manifest.device;
  if (!plainObject(device)) fail('Structured device identity is required.');
  else {
    report.device = { vendorId: device.vendorId, productId: device.productId, model: device.model, serial: device.serial };
    if (device.vendorId !== 0x38be || device.productId !== 0x0184 || device.model !== 'SK02') fail('Device must be the supported SK02 USB identity 38be:0184.');
    if (!validSerial(device.serial)) fail('Export device serial is absent or invalid.');
    else if (device.serial !== expectedSerial) fail('Export device serial does not exactly match the expected serial.');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length > TABLES.size) {
    fail('files must be an array with at most seven known entries.');
    return report;
  }
  const seen = new Set(), content = new Map();
  for (const entry of manifest.files) {
    if (!plainObject(entry) || typeof entry.name !== 'string' || !TABLES.has(entry.name)) {
      fail('Unknown file name or malformed file entry; paths are not allowed.');
      continue;
    }
    const name = entry.name, specification = TABLES.get(name);
    if (seen.has(name)) { fail(`Duplicate file entry: ${name}`); continue; }
    seen.add(name);
    const item = { name, kind: specification.kind, fileType: specification.fileType ?? null, valid: false };
    report.files.push(item);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < specification.min || entry.bytes > specification.max) {
      fail(`${name}: declared length must be ${specification.min}..${specification.max}.`); continue;
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) {
      fail(`${name}: expected a SHA-256 hex digest.`); continue;
    }
    try {
      const bytes = readBoundedFile(root, name, specification.max);
      item.bytes = bytes.length;
      item.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== entry.bytes) throw new Error('Actual length differs from manifest');
      if (item.sha256 !== entry.sha256.toLowerCase()) throw new Error('SHA-256 differs from manifest');
      item.valid = true;
      content.set(name, bytes);
    } catch (error) { fail(`${name}: ${error.message}`); }
  }
  for (const [name, spec] of TABLES) if (!spec.optional && !seen.has(name)) fail(`Missing required export file: ${name}`);
  const wire = content.get('thermometry-wire-body.bin');
  const calibration = content.get('thermometry-calibration.bin');
  if (wire && calibration) {
    if (wire.length < 69 || wire.readUInt32LE(64) !== wire.length - 68 || !wire.subarray(68).equals(calibration)) {
      fail('Thermometry calibration does not match the length and payload preserved in its wire body.');
    } else report.thermometryWirePayloadMatches = true;
  }
  report.valid = report.errors.length === 0;
  return report;
}

module.exports = { validateExport, FORMAT };
