const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { PROFILE, FrameAssembler } = require('./thermal.cjs');

function ffmpegPath() {
  const binary = process.env.CALORAVIEW_FFMPEG || require('ffmpeg-static');
  return binary.includes('app.asar') ? binary.replace('app.asar', 'app.asar.unpacked') : binary;
}

function captureArgs(device, platform = process.platform) {
  const format = ['-pixel_format', 'yuyv422', '-video_size', `${PROFILE.width}x${PROFILE.height}`, '-framerate', String(PROFILE.fps)];
  const input = platform === 'win32'
    ? ['-f', 'dshow', ...format, '-rtbufsize', '16M', '-i', `video=${device}`]
    : platform === 'darwin'
      ? ['-f', 'avfoundation', ...format, '-i', `${device}:none`]
      : (() => { throw new Error('Camera capture supports Windows and macOS.'); })();
  // Stream-copy is essential: color conversion would destroy the sensor words.
  return ['-hide_banner', '-loglevel', 'info', ...input, '-an', '-c:v', 'copy', '-f', 'rawvideo', 'pipe:1'];
}

function parseDevices(stderr, platform = process.platform) {
  const result = [];
  let video = platform === 'win32';
  let current = null;
  for (const line of stderr.split(/\r?\n/)) {
    if (platform === 'win32') {
      const name = line.match(/\] "([^"]+)" \(video\)/);
      if (name) { current = { name: name[1], id: name[1] }; result.push(current); }
      const alternative = line.match(/Alternative name "([^"]+)"/);
      if (alternative && current) { current.id = alternative[1]; current = null; }
    } else {
      if (line.includes('AVFoundation video devices:')) video = true;
      if (line.includes('AVFoundation audio devices:')) video = false;
      const match = line.match(/\] \[(\d+)\] (.+)$/);
      if (video && match) result.push({ id: match[1], name: match[2] });
    }
  }
  return result;
}

async function listDevices() {
  const args = process.platform === 'win32' ? ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']
    : ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true });
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Camera enumeration timed out.')); }, 10000);
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-65536); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', () => { clearTimeout(timeout); resolve(parseDevices(stderr)); });
  });
}

class Camera extends EventEmitter {
  async start(device) {
    if (this.child) throw new Error('Camera is already running.');
    this.stopping = false;
    this.frames = 0;
    this.assembler = new FrameAssembler();
    const child = this.child = spawn(ffmpegPath(), captureArgs(device), { windowsHide: true });
    let stderr = '';
    let validated = false;
    let badFormat = false;
    let pending = [];
    let pendingBytes = 0;
    const fail = message => {
      if (this.stopping) return;
      this.stopping = true;
      this.emit('capture-error', new Error(message));
      child.kill();
    };
    const consume = chunk => {
      for (const raw of this.assembler.push(chunk)) {
        this.lastFrameAt = Date.now();
        this.frames++;
        this.emit('frame', raw);
      }
    };
    child.stderr.on('data', b => {
      stderr = (stderr + b).slice(-20000);
      if (/Video: rawvideo .*yuyv422[^\n]*264x222/.test(stderr)) validated = true;
      if (/Video: rawvideo .*\b(uyvy422|nv12|yuv420p|rgb24|bgr24)\b/.test(stderr)) badFormat = true;
      if (badFormat) fail('The camera returned a converted pixel format. Raw capture was stopped to protect detector data.');
      if (validated && !badFormat && !this.stopping && pending.length) {
        for (const chunk of pending) consume(chunk);
        pending = []; pendingBytes = 0;
      }
    });
    child.stdout.on('data', chunk => {
      if (badFormat || this.stopping) return;
      if (!validated) {
        pending.push(chunk); pendingBytes += chunk.length;
        if (pendingBytes > PROFILE.frameBytes * 10) fail('Raw format could not be verified before receiving camera frames.');
        return;
      }
      consume(chunk);
    });
    child.once('error', error => fail(error.message));
    child.once('close', code => {
      clearInterval(this.watchdog);
      this.child = null;
      if (!this.stopping) this.emit('capture-error', new Error(`Camera disconnected or capture failed (${code}). ${stderr.slice(-1500)}`));
      this.emit('closed');
    });
    this.lastFrameAt = Date.now();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastFrameAt > 10000) fail(`No raw frames received. Close other camera apps and reconnect the SK02. ${stderr.slice(-1000)}`);
    }, 1000);
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.watchdog);
    const child = this.child;
    if (!child) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); }, 1500);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.stdin.on('error', () => {});
      child.stdin.write('q');
    });
  }
}

class Replay extends EventEmitter {
  async start(filename) {
    const size = (await fs.promises.stat(filename)).size;
    if (!size || size % PROFILE.frameBytes) throw new Error('File is not a complete SK02 264 × 222 raw recording.');
    this.handle = await fs.promises.open(filename, 'r');
    this.offset = 0;
    this.stopping = false;
    const tick = async () => {
      try {
        const raw = Buffer.alloc(PROFILE.frameBytes);
        const { bytesRead } = await this.handle.read(raw, 0, raw.length, this.offset);
        if (this.stopping) return;
        if (bytesRead !== raw.length) { await this.stop(); this.emit('ended'); return; }
        this.offset += bytesRead;
        this.emit('frame', raw);
        this.timer = setTimeout(tick, 1000 / PROFILE.fps);
      } catch (error) { if (!this.stopping) this.emit('capture-error', error); }
    };
    this.timer = setTimeout(tick, 0);
  }
  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    if (this.handle) { await this.handle.close(); this.handle = null; }
  }
}

module.exports = { Camera, Replay, listDevices, parseDevices, captureArgs, ffmpegPath };
