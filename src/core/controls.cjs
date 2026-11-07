const { spawn } = require('node:child_process');
const fs = require('node:fs');

function controlAvailable(binary) { return process.platform === 'win32' && fs.existsSync(binary); }

function shutterReference(binary, device, onStage) {
  if (!controlAvailable(binary)) throw new Error('Shutter control is currently available in the Windows build only.');
  if (typeof device !== 'string' || !/vid_38be&pid_0184/i.test(device)) throw new Error('Shutter control requires the verified SK02 device.');
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['shutter-reference', device], { windowsHide: true });
    let pending = '', stderr = '', result, parseError;
    const events = [];
    child.stdout.on('data', bytes => {
      pending += bytes;
      if (pending.length > 4 * 1024 * 1024) { parseError = new Error('Camera control output exceeds its limit.'); pending = ''; return; }
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'stage' && ['closed', 'opening', 'opened'].includes(event.stage)) {
            events.push(event); onStage(event);
          } else if (event.type === 'result') result = event;
        } catch (error) { parseError = error; }
      }
    });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4000); });
    child.once('error', reject);
    child.once('close', code => {
      if (parseError) reject(parseError);
      else if (code || !result?.ok || !events.some(e => e.stage === 'opened')) reject(new Error(result?.error || stderr || 'Shutter cycle did not confirm reopening.'));
      else resolve({ events, result });
    });
    // Do not forcibly kill this helper: its finally block must reopen/release
    // the shutter. App shutdown waits for the entire control operation.
  });
}

module.exports = { shutterReference, controlAvailable };
