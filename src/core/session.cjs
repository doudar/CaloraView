const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PROFILE } = require('./thermal.cjs');
const { ffmpegPath } = require('./capture.cjs');
const { validatedTemperatures } = require('./measurements.cjs');

const PREVIEW_CSV_HEADER = 'video_frame,source_sequence,raw_frame,timestamp_utc,video_time_ms,repeat,method,model,provider\n';
function previewCell(value) {
  if (typeof value !== 'string') return '';
  return '"' + value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160).replace(/"/g, '""') + '"';
}
const CSV_HEADER = 'timestamp_utc,elapsed_ms,sequence,source,calibration_status,center_c,high_c,low_c,center_counts,high_counts,low_counts,high_x,high_y,low_x,low_y,cavity_raw,cavity_drift_counts,cavity_internal_units,high_temperature_x,high_temperature_y,low_temperature_x,low_temperature_y,center_f,high_f,low_f,room_temperature_c,room_temperature_f,relative_humidity_percent,measurement_sample_sequence,measurement_sample_monotonic_ms,reflected_temperature_c,reflected_temperature_f,reflected_temperature_source\n';
function csvRow(frame, start, { elapsedMs } = {}) {
  const s = frame.stats;
  const temperatures = validatedTemperatures(frame);
  const sample = frame.measurementSample;
  const timestamp = sample?.fresh === true ? sample.timestamp : frame.timestamp;
  const environment = frame.environment || frame.calibration?.environment;
  const room = Number.isFinite(environment?.ambientC) ? environment.ambientC : null;
  const humidity = Number.isFinite(environment?.humidityPercent) && environment.humidityPercent >= 0 && environment.humidityPercent <= 100 ? environment.humidityPercent : null;
  return [new Date(timestamp).toISOString(), elapsedMs ?? timestamp - start, frame.sequence, frame.mode,
    temperatures ? 'factory-calibrated' : 'uncalibrated', temperatures?.center ?? '', temperatures?.high ?? '', temperatures?.low ?? '', s.center, s.high, s.low, s.highX, s.highY, s.lowX, s.lowY,
    frame.sensor?.sensorRaw ?? '', frame.sensor?.valid ? frame.sensor.sensorCounts : '', frame.sensor?.valid ? frame.sensor.sensorUnits : '',
    temperatures?.highX ?? '', temperatures?.highY ?? '', temperatures?.lowX ?? '', temperatures?.lowY ?? '',
    ...['center', 'high', 'low'].map(key => temperatures ? temperatures[key] * 9 / 5 + 32 : ''),
    room ?? '', room === null ? '' : room * 9 / 5 + 32, humidity ?? '',
    sample?.fresh === true ? sample.sequence : '', sample?.fresh === true ? sample.monotonicMs : '',
    Number.isFinite(environment?.reflectedC) ? environment.reflectedC : '',
    Number.isFinite(environment?.reflectedC) ? environment.reflectedC * 9 / 5 + 32 : '',
    Number.isFinite(environment?.reflectedC) ? (environment.reflectedManualOverride === false ? 'camera-initial-estimate' : 'manual') : ''].join(',') + '\n';
}
function createFolder(root, type) {
  fs.mkdirSync(root, { recursive: true });
  const prefix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${type}-`;
  return fs.mkdtempSync(path.join(root, prefix));
}

function writeAll(fd, data, position) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let written = 0;
  while (written < bytes.length) {
    const count = fs.writeSync(fd, bytes, written, bytes.length - written, position + written);
    if (count <= 0) throw new Error('Writing the capture file made no progress.');
    written += count;
  }
  return written;
}

class Session extends EventEmitter {
  constructor(root, { video = false, source = '', palette = 'iron', flatField = null, reference = null, calibration = null, environment = null, configuredEnvironment = null, temperatureUnit = 'C', logFrequencyHz = 2, preview = { width: PROFILE.imageWidth, height: PROFILE.imageHeight, resolution: 'native', rotation: 0 } } = {}) {
    super();
    if (![[256,192],[192,256],[512,384],[384,512]].some(([w,h]) => preview.width === w && preview.height === h)) throw new RangeError('Unsupported preview dimensions.');
    if (![.2, .5, 1, 2].includes(logFrequencyHz)) throw new RangeError('Logging frequency must be0.2,0.5,1 or2 Hz.');
    this.logFrequencyHz = logFrequencyHz;
    this.measurementRows = 0;
    this.measurementState = {};
    const fps = preview.fps ?? PROFILE.fps;
    if (![15, 25].includes(fps)) throw new RangeError('Preview recording fps must be15 or25.');
    this.preview = { ...preview, fps };
    this.videoFrames = 0;
    this.uniquePreviewFrames = 0;
    this.previewCsv = null;
    this.previewCsvBytes = 0;
    this.rawFrameMap = new Map();
    this.lastPreview = null;
    this.videoEpoch = null;
    this.lastPreviewSequence = null;
    this.folder = createFolder(root, video ? 'recording' : 'log');
    this.started = Date.now();
    this.frames = 0;
    this.closed = false;
    this.video = video;
    this.csv = null;
    this.raw = null;
    this.rawBytes = 0;
    this.csvBytes = 0;
    this.metadata = {
      schema: 'accuheat-session-v1', startedUtc: new Date(this.started).toISOString(), source,
      profile: PROFILE, calibration: calibration?.status === 'factory-calibrated' ? 'factory-calibrated' : 'unavailable', temperatureUnit: 'celsius', detectorUnit: 'counts',
      reference,
      factoryCalibration: calibration,
      displayTemperatureUnit: temperatureUnit === 'F' ? 'F' : 'C',
      logFrequencyHz, environmentSource: (environment ?? calibration?.environment)?.reflectedManualOverride === false ? 'configured-with-automatic-reflection' : 'configured',
      configuredEnvironment: structuredClone(configuredEnvironment ?? calibration?.configuredEnvironment ?? environment),
      environment: structuredClone(environment ?? calibration?.environment ?? null),
      temperatureValidation: 'Algorithm comparison and scene plausibility do not establish traceable temperature accuracy.',
      preview: { ...this.preview, palette, flatField: !!flatField, cropStatus: 'apk-routine-verified-runtime-unverified' },
      recordingTiming: 'Raw retains every received frame. Measurement CSV contains selected fresh samples. MP4 uses the frozen preview fps with repeated previous images for missing slots; preview-frames.csv maps each encoded image to its original source/raw frame.',
      note: 'Raw detector extrema are not temperature extrema. Complete USB frames are preserved without color conversion.'
    };
    try {
      this.csv = fs.openSync(path.join(this.folder, 'measurements.csv'), 'wx');
      this.csvBytes = writeAll(this.csv, CSV_HEADER, 0);
      this.raw = video ? fs.openSync(path.join(this.folder, 'sensor.raw'), 'wx') : null;
      if (video) {
        this.previewCsv = fs.openSync(path.join(this.folder, 'preview-frames.csv'), 'wx');
        this.previewCsvBytes = writeAll(this.previewCsv, PREVIEW_CSV_HEADER, 0);
      }
      if (flatField) fs.writeFileSync(path.join(this.folder, 'flat-field.f32'), Buffer.from(flatField.buffer, flatField.byteOffset, flatField.byteLength));
      this.saveMetadata();
      if (video) {
        this.encoder = spawn(ffmpegPath(), [
          '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'rgba',
          '-video_size', `${this.preview.width}x${this.preview.height}`, '-framerate', String(this.preview.fps),
          '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart', path.join(this.folder, 'preview.mp4')
        ], { windowsHide: true });
        this.encoderError = '';
        this.encoder.stderr.on('data', b => { this.encoderError = (this.encoderError + b).slice(-4000); });
        this.encoder.once('error', e => { this.encoderError = e.message; this.emit('session-error', e); });
        this.encoder.stdin.on('error', e => { if (!this.closed) this.emit('session-error', e); });
        this.encoderDone = new Promise(resolve => this.encoder.once('close', code => {
          this.encoderExit = code;
          if (!this.closed) this.emit('session-error', new Error(this.encoderError || 'Video encoder stopped unexpectedly.'));
          resolve(code);
        }));
      }
    } catch (error) {
      // A failed constructor has no caller-owned instance to stop. Release
      // everything here and retain the partial folder with a failure record.
      this.closed = true;
      for (const key of ['raw', 'csv', 'previewCsv']) {
        if (this[key] !== null) {
          try { fs.closeSync(this[key]); } catch { /* Preserve the original error. */ }
          this[key] = null;
        }
      }
      if (this.encoder) {
        this.encoder.once('error', () => {});
        this.encoder.stdin?.on('error', () => {});
        this.encoder.kill();
      }
      try { this.saveMetadata({ status: 'interrupted', error: error.message, endedUtc: new Date().toISOString() }); } catch { /* The disk may be unavailable. */ }
      throw error;
    }
  }
  addReference(reference, folder) {
    this.metadata.referenceHistory ||= [];
    this.metadata.referenceHistory.push({ ...reference, folder, beforeFrame: this.frames + 1 });
    this.saveMetadata();
  }
  saveMetadata(extra = {}) {
    fs.writeFileSync(path.join(this.folder, 'session.json'), JSON.stringify({ ...this.metadata, frames: this.frames, measurementRows: this.measurementRows, videoFrames: this.videoFrames, uniquePreviewFrames: this.uniquePreviewFrames, ...extra }, null, 2));
  }
  measurementPlan(frame) {
    const state = { ...this.measurementState };
    const sample = frame.measurementSample;
    const explicit = sample !== undefined;
    if (explicit && (sample?.fresh !== true || !Number.isSafeInteger(sample.sequence) || sample.sequence < 0
        || !Number.isFinite(sample.timestamp) || !Number.isFinite(sample.monotonicMs) || sample.monotonicMs < 0)) return { state, selected: false };
    const time = explicit ? sample.monotonicMs : frame.timestamp;
    if (!Number.isFinite(time) || (state.lastTime !== undefined && time <= state.lastTime)
        || (explicit && state.lastSequence !== undefined && sample.sequence <= state.lastSequence)) return { state, selected: false };
    state.lastTime = time;
    if (explicit) state.lastSequence = sample.sequence;
    // The upstream sampler is already anchored at2 Hz. Accept all fresh2 Hz
    // attempts, including480/520 ms frame-quantization jitter. Lower logging
    // rates retain an anchored deadline with one camera-frame allowance.
    const allowance = explicit ? 1000 / PROFILE.fps : 0;
    const selected = (explicit && this.logFrequencyHz === 2) || state.nextTime === undefined || time + allowance >= state.nextTime;
    if (!selected) return { state, selected: false };
    const interval = 1000 / this.logFrequencyHz;
    if (state.nextTime === undefined) state.nextTime = time + interval;
    else if (time + allowance >= state.nextTime) state.nextTime += (Math.floor((time + allowance - state.nextTime) / interval) + 1) * interval;
    const timestamp = explicit ? sample.timestamp : frame.timestamp;
    if (state.anchorTime === undefined) { state.anchorTime = time; state.anchorElapsed = Math.max(0, timestamp - this.started); }
    return { state, selected: true, elapsedMs: state.anchorElapsed + time - state.anchorTime };
  }
  append(raw, frame, { videoFrame = true } = {}) {
    if (this.closed) return;
    if (this.writeError) throw this.writeError;
    if (videoFrame && this.encoder && this.encoder.stdin.writableLength > 16 * 1024 * 1024) throw new Error('Video encoding cannot keep up. Recording stopped; existing raw frames and CSV are preserved.');
    if (this.raw !== null && (!Buffer.isBuffer(raw) || raw.length !== PROFILE.frameBytes)) throw new Error('Recording requires one complete raw SK02 frame.');
    if (videoFrame && this.encoder && (frame.width !== this.preview.width || frame.height !== this.preview.height || !frame.rgba || frame.rgba.length !== this.preview.width * this.preview.height * 4)) throw new Error('Recording requires one complete RGBA preview frame.');
    const plan = this.measurementPlan(frame);
    const row = plan.selected ? Buffer.from(csvRow(frame, this.started, { elapsedMs: plan.elapsedMs })) : null;
    try {
      if (this.raw !== null) writeAll(this.raw, raw, this.rawBytes);
      if (row) writeAll(this.csv, row, this.csvBytes);

      if (this.raw !== null) this.rawBytes += raw.length;
      if (row) { this.csvBytes += row.length; this.measurementRows++; }
      this.measurementState = plan.state;
      this.frames++;
      if (this.raw !== null && Number.isSafeInteger(frame.sequence)) {
        this.rawFrameMap.set(frame.sequence, { index: this.frames, timestamp: frame.timestamp, monotonicMs: frame.captureMonotonicMs });
        if (this.rawFrameMap.size > 512) this.rawFrameMap.delete(this.rawFrameMap.keys().next().value);
      }
    } catch (error) {
      this.writeError = error;
      // Roll back the incomplete append to the last complete raw frame and
      // measurement row; their counts deliberately differ. Report any failure to restore their last good lengths.
      try { if (this.raw !== null) fs.ftruncateSync(this.raw, this.rawBytes); }
      catch (rollbackError) { error.message += ` Raw rollback failed: ${rollbackError.message}`; }
      try { fs.ftruncateSync(this.csv, this.csvBytes); }
      catch (rollbackError) { error.message += ` CSV rollback failed: ${rollbackError.message}`; }
      throw error;
    }
    if (videoFrame && this.encoder) this.appendVideo(frame);
  }
  appendVideo(frame) {
    if (this.closed || !this.encoder) return false;
    if (this.writeError) throw this.writeError;
    const source = this.rawFrameMap.get(frame?.sequence);
    if (!source || (this.lastPreviewSequence !== null && frame.sequence <= this.lastPreviewSequence)) return false;
    if (frame.width !== this.preview.width || frame.height !== this.preview.height || !frame.rgba || frame.rgba.length !== this.preview.width * this.preview.height * 4) throw new Error('Recording requires one complete RGBA preview frame.');
    if (!Number.isFinite(source.timestamp) || frame.timestamp !== source.timestamp) throw new Error('Preview source timestamp does not match the recorded raw frame.');
    const clock = Number.isFinite(source.monotonicMs) ? source.monotonicMs : source.timestamp;
    if (Number.isFinite(source.monotonicMs) && frame.captureMonotonicMs !== source.monotonicMs) throw new Error('Preview monotonic timestamp does not match the recorded raw frame.');
    if (this.lastPreview && clock < this.lastPreview.clock) return false;
    const epoch = this.videoEpoch ?? clock;
    const slot = Math.round((clock - epoch) * this.preview.fps / 1000);
    if (slot < this.videoFrames) return false;
    if (this.lastPreview && (clock - this.lastPreview.clock > 2000 || slot - this.videoFrames > this.preview.fps * 2)) throw new Error('Enhanced preview stalled more than2 seconds; recording stopped without unbounded frame duplication.');
    const transform = frame.displayTransform || {};
    const item = { sequence: frame.sequence, timestamp: source.timestamp, rawFrame: source.index, clock,
      rgba: Buffer.from(frame.rgba), method: transform.method || 'native',
      model: transform.model || frame.enhancement?.model || '', provider: transform.provider || frame.enhancement?.provider || '' };
    try {
      while (this.videoFrames < slot) this.writeVideoFrame(this.lastPreview, true);
      this.writeVideoFrame(item, false);
      if (this.videoEpoch === null) {
        this.videoEpoch = epoch;
        this.metadata.videoStart = { timestamp: new Date(source.timestamp).toISOString(), sourceSequence: frame.sequence,
          rawFrame: source.index, captureMonotonicMs: Number.isFinite(source.monotonicMs) ? source.monotonicMs : null };
      }
      this.lastPreview = item;
      this.lastPreviewSequence = frame.sequence;
      this.uniquePreviewFrames++;
      return true;
    } catch (error) { this.writeError = error; throw error; }
  }
  writeVideoFrame(item, repeat) {
    if (!item) throw new Error('Cannot fill preview slots without a previous image.');
    if (this.encoder.stdin.writableLength > 16 * 1024 * 1024) throw new Error('Video encoding cannot keep up. Recording stopped; existing data is preserved.');
    const row = Buffer.from([this.videoFrames + 1, item.sequence, item.rawFrame, new Date(item.timestamp).toISOString(),
      this.videoFrames * 1000 / this.preview.fps, repeat ? 1 : 0, previewCell(item.method), previewCell(item.model), previewCell(item.provider)].join(',') + '\n');
    try {
      writeAll(this.previewCsv, row, this.previewCsvBytes);
      this.encoder.stdin.write(item.rgba);
      this.previewCsvBytes += row.length;
      this.videoFrames++;
    } catch (error) {
      try { fs.ftruncateSync(this.previewCsv, this.previewCsvBytes); }
      catch (rollbackError) { error.message += ` Preview manifest rollback failed: ${rollbackError.message}`; }
      throw error;
    }
  }
  stop(reason = null) {
    if (reason && !this.stopReason) this.stopReason = reason;
    if (this.stopPromise) return this.stopPromise;
    this.closed = true;
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }
  async finishStop() {
    this.stopReason ||= this.writeError?.message || null;
    for (const key of ['raw', 'csv', 'previewCsv']) {
      if (this[key] !== null) {
        try { fs.closeSync(this[key]); }
        catch (error) { this.stopReason ||= error.message; }
        this[key] = null;
      }
    }
    if (this.encoder) {
      try { this.encoder.stdin.end(); }
      catch (error) { this.stopReason ||= error.message; this.encoder.kill(); }
      const timeout = setTimeout(() => this.encoder.kill(), 15000);
      try { await this.encoderDone; }
      finally { clearTimeout(timeout); }
      if (this.encoderExit !== 0) this.stopReason ||= this.encoderError || 'Video finalization failed.';
    }
    if (this.stopReason) this.finalError = this.stopReason;
    try {
      this.saveMetadata({ endedUtc: new Date().toISOString(), status: this.stopReason ? 'interrupted' : 'complete', error: this.stopReason });
    } catch (error) { this.finalError ||= error.message; throw error; }
    return this.folder;
  }
}

module.exports = { Session, CSV_HEADER, PREVIEW_CSV_HEADER, csvRow, createFolder };
