'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const crypto = require('node:crypto');
const { validateExport } = require('./calibration-export.cjs');

function runCalibrationHelper(binary, device, command, extra, onStage = () => {}, timeoutMs = 90000) {
  if (process.platform !== 'win32' || !fs.existsSync(binary)) throw new Error('Calibration download is currently available on Windows only.');
  if (typeof device !== 'string' || !/vid_38be&pid_0184.*#/i.test(device)) throw new Error('Select the verified SK02 camera.');
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [command, device, ...extra], { windowsHide: true });
    const decoder = new StringDecoder('utf8');
    let pending = '', stderr = '', result, failure, total = 0;
    // This helper only selects and reads files; unlike the shutter helper it
    // can be terminated without leaving a mechanically closed shutter.
    const timer = setTimeout(() => { failure = new Error('Calibration operation timed out.'); child.kill(); }, timeoutMs);
    child.stdout.on('data', bytes => {
      total += bytes.length;
      if (total > 1024 * 1024) { failure = new Error('Calibration helper output exceeded its limit.'); child.kill(); return; }
      pending += decoder.write(bytes);
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
        if (!line) continue;
        try {
          const item = JSON.parse(line);
          if (item.type === 'stage') onStage(item);
          else if (item.type === 'result') result = item;
        } catch (error) { failure = error; }
      }
    });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4000); });
    child.once('error', error => {
      failure = error;
      // Failed spawn has no process to await. A later process/kill error must
      // retain ownership until close, preventing another camera operation.
      if (!child.pid) { clearTimeout(timer); reject(error); }
    });
    child.once('close', code => {
      clearTimeout(timer);
      try {
        if (failure) throw failure;
        if (code || !result?.ok) throw new Error(result?.error || stderr || 'Calibration download failed.');
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}
async function identifyCalibration(binary, device) {
  const result = await runCalibrationHelper(binary, device, 'calibration-identity', [], undefined, 20000);
  if (result.protocolVersion !== '2.0' || typeof result.serial !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(result.serial)
    || typeof result.deviceIdentityHex !== 'string' || !/^[a-f0-9]{976}$/i.test(result.deviceIdentityHex)
    || crypto.createHash('sha256').update(Buffer.from(result.deviceIdentityHex, 'hex')).digest('hex') !== result.deviceIdentitySha256) {
    throw new Error('Camera identity response failed validation.');
  }
  return result;
}
async function downloadCalibration(binary, device, directory, onStage) {
  const result = await runCalibrationHelper(binary, device, 'download-calibration', [directory], onStage);
  if (typeof result.directory !== 'string' || path.resolve(result.directory) !== path.resolve(directory)) throw new Error('Calibration helper returned an unexpected directory.');
  const validation = validateExport(directory, { expectedSerial: result.serial });
  fs.writeFileSync(path.join(directory, 'validation.json'), JSON.stringify(validation, null, 2));
  if (!validation.valid) throw new Error(`Downloaded calibration failed validation: ${validation.errors.join(' ')}`);
  return { folder: directory, serial: result.serial, files: validation.files.length, validation };
}
module.exports = { downloadCalibration, identifyCalibration };
