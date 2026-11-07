'use strict';
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const path = require('node:path');

/** One active inference plus the newest pending frame; never transfers camera buffers. */
class NeuralPreview extends EventEmitter {
  constructor({ workerFactory = (file, options) => new Worker(file, options),
    modelDir = path.join(__dirname, '../models'), initTimeoutMs = 60000, inferenceTimeoutMs = 3000 } = {}) {
    super();
    for (const value of [initTimeoutMs, inferenceTimeoutMs]) {
      if (!Number.isFinite(value) || value <= 0) throw new RangeError('Worker timeouts must be positive milliseconds');
    }
    this.workerFactory = workerFactory;
    this.modelDir = modelDir;
    this.initTimeoutMs = initTimeoutMs;
    this.inferenceTimeoutMs = inferenceTimeoutMs;
    this.worker = null;
    this.started = false;
    this.ready = false;
    this.failed = false;
    this.closed = false;
    this.active = null;
    this.pending = null;
    this.nextId = 1;
    this.timer = null;
    this.termination = null;
  }

  start() {
    if (this.started || this.closed || this.failed) return;
    this.started = true;
    this.emit('state', { enhancementState: 'loading', enhancementMessage: 'Preparing local AI image enhancement…' });
    if (this.closed) return;
    try {
      this.worker = this.workerFactory(path.join(__dirname, 'neural-worker.cjs'), { workerData: { modelDir: this.modelDir } });
      this.worker.on('message', message => this._message(message));
      // Keep these guards attached until termination: late errors must never become uncaught.
      this.worker.on('error', error => this._fail(error?.message || String(error)));
      this.worker.on('exit', code => this._fail('Image enhancement worker exited (' + code + ').'));
      this._arm(this.initTimeoutMs, 'AI model initialization timed out.');
    } catch (error) { this._fail(error?.message || String(error)); }
  }

  submit(job) {
    if (!this.ready || this.failed || this.closed) return false;
    const gray = job?.nativeFrame?.displayGray;
    if (!(gray instanceof Float32Array) || gray.length !== 256 * 192) return false;
    if (this.active) this.pending = job;
    else this._dispatch(job);
    return !this.failed && !this.closed;
  }

  cancel() {
    this.pending = null;
    if (this.active) {
      this.active.canceled = true;
      this.active.job = null;
      // Let the in-flight call finish, but retain a bounded grace period.
      this._arm(this.inferenceTimeoutMs, 'AI image enhancement timed out.');
    }
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.ready = false;
      this._clearTimer();
      this.active = null;
      this.pending = null;
      this._terminate();
    }
    return this.termination || Promise.resolve();
  }

  _dispatch(job) {
    const id = this.nextId++;
    this.active = { id, job, canceled: false };
    this._arm(this.inferenceTimeoutMs, 'AI image enhancement timed out.');
    try {
      // Structured clone copies only the display plane. No transfer list: raw/session data stay owned by the caller.
      this.worker.postMessage({ id, gray: job.nativeFrame.displayGray });
    } catch (error) { this._fail(error?.message || String(error)); }
  }

  _message(message) {
    if (this.closed || this.failed || !message || typeof message !== 'object') return;
    if (message.type === 'failure') { this._fail(message.message || 'AI image enhancement failed.'); return; }
    if (message.type === 'ready') {
      if (this.ready) return;
      this._clearTimer();
      this.ready = true;
      this.emit('state', { enhancementState: 'ready', enhancementMessage: (message.model || 'Local AI') + ' image enhancement ready.' });
      return;
    }
    const active = this.active;
    if (message.type !== 'result' || !active || message.id !== active.id) return;
    this._clearTimer();
    if (!(message.gray instanceof Float32Array) || message.width !== 512 || message.height !== 384 || message.gray.length !== 512 * 384) {
      this._fail('AI image enhancement returned an invalid display plane.'); return;
    }
    if (!active.canceled) this.emit('frame', { job: active.job, result: message });
    // A frame listener can cancel, close, or enqueue newer work synchronously.
    if (this.closed || this.failed) return;
    this._clearTimer();
    this.active = null;
    const next = this.pending;
    this.pending = null;
    if (next) this._dispatch(next);
  }

  _clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  _arm(delay, message) {
    this._clearTimer();
    this.timer = setTimeout(() => this._fail(message), delay);
    this.timer.unref?.();
  }
  _terminate() {
    if (this.termination) return;
    const worker = this.worker;
    this.worker = null;
    try { this.termination = Promise.resolve(worker?.terminate()).catch(() => {}); }
    catch { this.termination = Promise.resolve(); }
  }
  _fail(reason) {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.ready = false;
    this._clearTimer();
    this.active = null;
    this.pending = null;
    this._terminate();
    const message = String(reason);
    this.emit('state', { enhancementState: 'fallback', enhancementMessage: message + ' Using smooth display interpolation.' });
    if (!this.closed) this.emit('failure', message);
  }
}
module.exports = { NeuralPreview };
