'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { identifyCalibration, downloadCalibration } = require('./calibration-download.cjs');
const { validateExport } = require('./calibration-export.cjs');

function matchesIdentity(report, identity) {
  return report.valid && report.device.serial === identity.serial
    && report.files.find(file => file.name === 'device-identity.bin')?.sha256 === identity.deviceIdentitySha256;
}

async function ensureCalibration({ cacheRoot, binary, device, force = false, requireVignetting = false, onStage = () => {} },
  { identify = identifyCalibration, download = downloadCalibration } = {}) {
  onStage({ stage: 'identity' });
  const identity = await identify(binary, device);
  if (identity.protocolVersion !== '2.0' || typeof identity.serial !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(identity.serial)
    || /^(unknown|unavailable|null|undefined|none|n\/a)$/i.test(identity.serial)
    || !/^[a-f0-9]{64}$/.test(identity.deviceIdentitySha256 || '')) throw new Error('Cannot bind calibration to a verified camera identity.');
  const root = path.resolve(cacheRoot);
  fs.mkdirSync(root, { recursive: true });
  const key = crypto.createHash('sha256').update(identity.serial + '\0' + identity.deviceIdentitySha256).digest('hex');
  const indexPath = path.join(root, key + '.json');
  if (!force) {
    try {
      const indexStat = fs.lstatSync(indexPath);
      if (!indexStat.isFile() || indexStat.isSymbolicLink() || indexStat.size > 4096) throw new Error('Invalid cache index.');
      const entry = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (![1, 2].includes(entry.version) || (requireVignetting && entry.version < 2) || entry.serial !== identity.serial || entry.identityHash !== identity.deviceIdentitySha256
        || typeof entry.folder !== 'string' || !new RegExp(`^${key}-[A-Za-z0-9]+$`).test(entry.folder)) throw new Error('Cache identity changed.');
      const folder = path.join(root, entry.folder);
      const validation = validateExport(folder, { expectedSerial: identity.serial });
      if (matchesIdentity(validation, identity)) {
        onStage({ stage: 'cached' });
        return { folder, serial: identity.serial, files: validation.files.length, validation, source: 'cache' };
      }
    } catch { /* Missing or damaged cache: fetch a new verified bundle. */ }
  }
  onStage({ stage: 'download' });
  const folder = fs.mkdtempSync(path.join(root, key + '-'));
  const result = await download(binary, device, folder, onStage);
  const validation = validateExport(folder, { expectedSerial: identity.serial });
  if (result.serial !== identity.serial || !matchesIdentity(validation, identity)) throw new Error('Camera identity changed during calibration download; files were not cached.');
  const entry = { version: requireVignetting ? 2 : 1, serial: identity.serial, identityHash: identity.deviceIdentitySha256, folder: path.basename(folder), savedUtc: new Date().toISOString() };
  const temporaryIndex = indexPath + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temporaryIndex, JSON.stringify(entry, null, 2), { flag: 'wx' });
  fs.renameSync(temporaryIndex, indexPath);
  onStage({ stage: 'saved' });
  return { folder, serial: identity.serial, files: validation.files.length, validation, source: 'download' };
}
module.exports = { ensureCalibration };
