const { app, BrowserWindow, ipcMain, dialog, nativeImage, shell, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Camera, Replay, listDevices } = require('./core/capture.cjs');
const { PROFILE, decodeFrame, makeFlatField, colorizeGray } = require('./core/thermal.cjs');
const { Session, createFolder } = require('./core/session.cjs');
const { shutterReference, controlAvailable } = require('./core/controls.cjs');
const { readFrameMetadata } = require('./core/frame-metadata.cjs');
const { ensureCalibration } = require('./core/calibration-cache.cjs');
const { waitForCameraFrames } = require('./core/initialization.cjs');
const { validatedTemperatures } = require('./core/measurements.cjs');
const { createFactoryProcessor } = require('./core/factory-processor.cjs');
const { createRadiometry } = require('./core/radiometry.cjs');
const { transformPreview } = require('./core/display-transform.cjs');
const { loadPreferences, savePreferences, validateMeasurementEnvironment, DEFAULT_MEASUREMENT_ENVIRONMENT } = require('./core/preferences.cjs');
const { TemperatureSampler } = require('./core/temperature-sampler.cjs');
const temperatureSampler = new TemperatureSampler({ intervalMs: 500 });
const { NeuralPreview } = require('./core/neural-preview.cjs');
let enhancer, latestInput = null, previewGeneration = 0;

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => {
  if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.focus(); }
});

let window, source, latest, flatField = null, recorder = null, logger = null;
let palette = 'iron', resolution = 'enhanced', rotation = 0, devices = [], framePending = false, closing = false, busy = false;
let shutdownComplete = false, initializationOperation = null, captureGeneration = 0;
let calibrationBytes = null;
let factoryProcessor = null, radiometry = null, automaticReferenceScheduled = false, lastAutomaticReferenceAttempt = 0;
let controlBinary, calibrationRoot, preferencesPath, activeDevice = '', controlOperation = null, shutterCapture = null, referenceInfo = null;
const finalizing = new Set();
let status = { enhancementState: 'loading', enhancementMessage: 'HD enhancement starts when selected.', logFrequencyHz: 2, temperatureUnit: 'C', measurementEnvironment: { ...DEFAULT_MEASUREMENT_ENVIRONMENT }, previewResolution: 'enhanced', rotation: 0, initializationBusy: false, initializationProgress: null, initializationMessage: '', connected: false, connecting: false, recording: false, logging: false, shutterSupported: false, shutterBusy: false, calibrationSupported: false, calibrationBusy: false, calibrationDownloaded: false, calibrationDevice: '', calibrationSerial: '', calibrationFolder: '', calibrationSource: '', calibrationError: null, source: '', mode: 'raw', frames: 0, message: 'Connect your AccuMEMS SK02 to begin.', error: null };

function publish(patch = {}) {
  status = { ...status, ...patch };
  if (window && !window.isDestroyed()) window.webContents.send('caloraview:status', status);
}
function sendFrame() {
  if (!latest || framePending || !window || window.isDestroyed()) return;
  const { detector, displayGray, ...frame } = latest.frame;
  framePending = true;
  window.webContents.send('caloraview:frame', frame);
}
async function stopSessions(reason = null) {
  const sessions = [recorder, logger].filter(Boolean);
  recorder = logger = null;
  publish({ recording: false, logging: false });
  for (const session of sessions) finishSession(session, reason);
  const results = await Promise.allSettled([...finalizing]);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  const interrupted = sessions.find(session => session.finalError);
  if (interrupted) throw new Error(interrupted.finalError);
}
function finishSession(session, reason = null) {
  const operation = session.stop(reason);
  finalizing.add(operation);
  operation.then(() => finalizing.delete(operation), () => finalizing.delete(operation));
  return operation;
}
async function disconnect() {
  captureGeneration++;
  previewGeneration++;
  enhancer?.cancel();
  latestInput = null;
  if (controlOperation) await controlOperation.catch(() => {});
  const previous = source;
  source = null;
  try {
    try { if (previous) { previous.removeAllListeners(); await previous.stop(); } }
    finally { await stopSessions(); }
  } finally {
    latest = null;
    flatField = null;
    factoryProcessor = radiometry = calibrationBytes = null;
    temperatureSampler.reset();
    lastAutomaticReferenceAttempt = 0;
    referenceInfo = null;
    activeDevice = '';
    framePending = false;
    publish({ connected: false, connecting: false, automaticReflectedC: null, initializationBusy: false, initializationProgress: null, initializationMessage: '', shutterSupported: false, message: 'Camera stopped.', frames: 0 });
  }
}
function acceptFrame(raw) {
  try {
    if (shutterCapture?.closedAt && Date.now() >= shutterCapture.closedAt + 150 && Date.now() < shutterCapture.closedAt + 1000) {
      shutterCapture.frames.push(Buffer.from(raw));
    }
    const timestamp = Date.now(), monotonicMs = performance.now(), sequence = ++status.frames;
    const sensor = readFrameMetadata(raw);
    if (radiometry && status.mode === 'raw' && sensor.valid) {
      const automaticReflectedC = radiometry.observeSensor(sensor.sensorRaw);
      if (automaticReflectedC !== status.automaticReflectedC) publish({ automaticReflectedC });
    }
    let processing = null;
    let reason = status.mode === 'replay' ? 'Raw replay has no restored factory state.' : 'Factory calibration is not ready.';
    if (factoryProcessor && radiometry && status.mode === 'raw') {
      if (status.shutterBusy) reason = 'shutter-active';
      else {
        processing = factoryProcessor.process(raw);
        reason = processing.reason;
        if (reason === 'sensor-drift-needs-reference') scheduleAutomaticReference();
      }
    }
    const measurement = temperatureSampler.sample({ monotonicMs, timestamp, sequence,
      available: !!processing?.valid,
      evaluate: () => radiometry.evaluate(processing.corrected, processing.metadata),
      unavailable: { temperatures: null, calibration: { status: 'unavailable', reason } }
    });
    // Attach current reference without mutating the sampler's held provenance.
    if (referenceInfo) measurement.calibration = { ...measurement.calibration, reference: referenceInfo };
    const factoryPlane = processing?.corrected || null;
    const decoded = decodeFrame(raw, { flatField, factoryPlane, palette });
    const nativeFrame = { ...decoded, ...measurement, environment: measurement.calibration?.environment || radiometry?.environment || null,
      factoryCorrected: !!factoryPlane, sensor, sequence, timestamp, mode: status.mode, flatField: !!flatField };
    if (!validatedTemperatures(nativeFrame)) nativeFrame.temperatures = null;
    nativeFrame.captureMonotonicMs = monotonicMs;
    const job = { raw: Buffer.from(raw), nativeFrame, factoryPlane, palette, resolution, rotation,
      generation: previewGeneration, sourceGeneration: captureGeneration };
    latestInput = job;
    if (!nativeFrame.temperatures && latest?.frame.temperatures) {
      latest.frame = { ...latest.frame, temperatures: null, calibration: nativeFrame.calibration };
      sendFrame();
    }
    if (!status.connected) publish({ connected: true, connecting: status.initializationBusy, error: null, message: status.mode === 'replay' ? 'Replaying recorded raw frames.' : 'Receiving camera frames; preparing factory calibration.' });
    // Raw data and measurement logging never wait for display inference.
    for (const session of [recorder, logger].filter(Boolean)) session.append(raw, nativeFrame, { videoFrame: false });
    queuePreview(job);
  } catch (error) { stopSessions(error.message).catch(() => {}); publish({ error: error.message }); }
}
function queuePreview(job, immediate = false) {
  // Settings must publish the new geometry immediately so a capture cannot
  // freeze the previous orientation while the neural worker is still busy.
  if (immediate) presentPreview(job);
  if (job.resolution === 'enhanced') {
    enhancer.start();
    if (enhancer.submit(job)) return;
  }
  presentPreview(job);
}
function presentPreview(job, result = null) {
  if (closing || job.generation !== previewGeneration || job.sourceGeneration !== captureGeneration || !source || !status.connected) return;
  if (latest && job.nativeFrame.sequence < latest.nativeFrame.sequence) return;
  try {
    const enhanced = result ? { ...result, rgba: colorizeGray(result.gray, job.palette) } : null;
    const nativeFrame = { ...job.nativeFrame };
    // Never restore held Celsius after a newer frame has invalidated it.
    if (status.shutterBusy || (latestInput && !validatedTemperatures(latestInput.nativeFrame))) {
      nativeFrame.temperatures = null;
      nativeFrame.calibration = { status: 'unavailable', reason: status.shutterBusy ? 'shutter-active' : latestInput.nativeFrame.calibration?.reason || 'Current measurement unavailable.' };
    }
    const frame = transformPreview(nativeFrame, { resolution: job.resolution, rotation: job.rotation, enhanced });
    if (job.resolution === 'enhanced' && !enhanced) frame.displayTransform.fallbackReason = status.enhancementMessage;
    latest = { raw: job.raw, frame, nativeFrame, factoryPlane: job.factoryPlane };
    if (recorder) recorder.appendVideo(frame);
    sendFrame();
  } catch (error) { stopSessions(error.message).catch(() => {}); publish({ error: error.message }); }
}

function bindSource(current) {
  const generation = ++captureGeneration;
  source = current;
  current.on('frame', acceptFrame);
  current.once('capture-error', async error => {
    if (source !== current) return;
    source = null;
    latestInput = null;
    enhancer?.cancel();
    latest = null;
    publish({ connected: false, connecting: false, initializationBusy: false, error: error.message, message: 'Capture stopped.' });
    const finishing = stopSessions(error.message);
    finishing.catch(() => {});
    try { await current.stop(); await finishing; }
    catch (cleanupError) { error.message += ` Finalization: ${cleanupError.message}`; }
    finally {
      if (generation !== captureGeneration) return;
      latest = null;
      publish({ connected: false, connecting: false, error: error.message, message: 'Capture stopped.' });
    }
  });
  current.once('ended', async () => {
    if (source !== current) return;
    source = null;
    latestInput = null;
    enhancer?.cancel();
    latest = null;
    publish({ connected: false, connecting: false, message: 'Replay complete.' });
    try { await stopSessions(); }
    catch (error) { if (generation === captureGeneration) publish({ error: error.message }); }
    finally { if (generation === captureGeneration) { latest = null; publish({ connected: false, connecting: false }); } }
  });
}
function requireFrame() {
  if (status.initializationBusy) throw new Error('Wait for camera initialization to finish.');
  if (!latest || !status.connected) throw new Error('Connect the camera or open a recording first.');
}
function lockedSettings() {
  if (recorder || logger) throw new Error('Stop recording and logging before changing image processing.');
}

function scheduleAutomaticReference() {
  if (automaticReferenceScheduled || closing || busy || controlOperation || status.initializationBusy || !status.shutterSupported || Date.now() - lastAutomaticReferenceAttempt < 10000) return;
  automaticReferenceScheduled = true;
  setImmediate(async () => {
    automaticReferenceScheduled = false;
    if (closing || busy || controlOperation || !source || !status.connected) return;
    busy = true;
    lastAutomaticReferenceAttempt = Date.now();
    try { await captureShutterReference(); }
    catch (error) { publish({ error: error.message, message: 'Automatic reference failed. Auto calibrate can retry; unavailable temperatures are left blank.' }); }
    finally { busy = false; }
  });
}

function initializationStage(progress, message) {
  if (status.initializationBusy) publish({ initializationProgress: progress, initializationMessage: message });
}

async function captureShutterReference() {
  publish({ shutterBusy: true, error: null, message: 'Capturing an internal shutter reference…' });
  const originalSource = source;
  shutterCapture = { closedAt: null, frames: [] };
  controlOperation = (async () => {
    try {
      const evidence = await shutterReference(controlBinary, activeDevice, event => {
        if (event.stage === 'closed') { shutterCapture.closedAt = Date.parse(event.timestamp); initializationStage(84, 'Capturing shutter reference…'); }
        if (event.stage === 'opening') { shutterCapture.closedAt = null; initializationStage(92, 'Applying shutter reference…'); }
      });
      if (source !== originalSource || !status.connected) throw new Error('The camera disconnected during the shutter cycle; its reference was not applied.');
      if (shutterCapture.frames.length < (factoryProcessor ? 16 : 10)) throw new Error('Shutter reopened, but too few reference frames arrived. Try again.');
      const nextFlatField = makeFlatField(shutterCapture.frames);
      const factoryReference = factoryProcessor?.setShutterReference(shutterCapture.frames, { shutterClosed: true }) || null;
      flatField = nextFlatField;
      referenceInfo = { source: 'internal-shutter', capturedUtc: new Date().toISOString(), frames: shutterCapture.frames.length, factoryReference };
      const folder = createFolder(status.outputDir, 'shutter-reference');
      referenceInfo.id = path.basename(folder);
      fs.writeFileSync(path.join(folder, 'reference.f32'), Buffer.from(flatField.buffer, flatField.byteOffset, flatField.byteLength));
      fs.writeFileSync(path.join(folder, 'sensor.raw'), Buffer.concat(shutterCapture.frames));
      fs.writeFileSync(path.join(folder, 'control.json'), JSON.stringify({ profile: PROFILE, frames: shutterCapture.frames.length, reference: referenceInfo, calibration: factoryReference ? 'factory-shutter-reference' : 'visual-reference-only', ...evidence }, null, 2));
      for (const session of [recorder, logger].filter(Boolean)) session.addReference(referenceInfo, folder);
      publish({ shutterBusy: false });
      await waitForCameraFrames(originalSource, { count: 2, timeoutMs: 5000 });
      publish({ message: factoryReference ? 'Factory calibration and shutter reference applied.' : 'Shutter reference applied to preview. Factory temperature calibration is unavailable.' });
      return { folder };
    } finally { shutterCapture = null; publish({ shutterBusy: false }); }
  })();
  try { return await controlOperation; } finally { controlOperation = null; }
}

async function prepareCalibration(device, force = false) {
  publish({ calibrationBusy: true, calibrationDownloaded: false, calibrationDevice: device.id, calibrationSerial: '', calibrationFolder: '', calibrationSource: '', calibrationError: null,
    message: 'Checking camera identity and saved calibration…' });
  controlOperation = ensureCalibration({ cacheRoot: calibrationRoot, binary: controlBinary, device: device.id, force, requireVignetting: true,
    onStage: event => {
      if (event.stage === 'identity') initializationStage(10, 'Checking camera identity…');
      if (event.stage === 'download') { initializationStage(25, 'Downloading camera calibration…'); publish({ message: 'Downloading this camera’s factory calibration for first use…' }); }
      const fileStages = { 'Reading BPM.bin': 28, 'Reading KMatrix.bin': 32, 'Reading KMatrix2.bin': 42, 'Reading thermometry-wire-body.bin': 49, 'Reading VC.bin': 52 };
      if (Object.hasOwn(fileStages, event.stage)) initializationStage(fileStages[event.stage], 'Downloading camera calibration...');
      if (event.stage === 'cached' || event.stage === 'saved') initializationStage(55, 'Camera calibration verified.');
    }
  });
  try {
    const result = await controlOperation;
    publish({ calibrationDownloaded: true, calibrationSerial: result.serial, calibrationFolder: result.folder, calibrationSource: result.source,
      message: result.source === 'cache' ? 'Saved camera calibration verified and reused.' : 'Camera calibration downloaded, verified, and saved for future connections.' });
    return { folder: result.folder, serial: result.serial, files: result.files, source: result.source };
  } catch (error) {
    publish({ calibrationError: error.message, calibrationDownloaded: false });
    throw error;
  } finally { controlOperation = null; publish({ calibrationBusy: false }); }
}

async function action(name, payload = {}) {
  switch (name) {
    case 'state': return { ...status };
    case 'devices': devices = await listDevices(); return { devices };
    case 'connect': {
      const device = devices.find(d => d.id === payload.device);
      if (!device) throw new Error('Select a camera from the device list.');
      await disconnect();
      if (process.platform === 'darwin' && !await systemPreferences.askForMediaAccess('camera')) throw new Error('Allow camera access in macOS System Settings, then restart Caloraview.');
      publish({ connecting: true, initializationBusy: true, initializationProgress: 5, initializationMessage: 'Preparing camera…', source: device.name, mode: 'raw', frames: 0, error: null, message: 'Initializing camera…' });
      activeDevice = device.id;
      publish({ calibrationDownloaded: false, calibrationDevice: '', calibrationSerial: '', calibrationFolder: '', calibrationSource: '', calibrationError: null });
      publish({ shutterSupported: controlAvailable(controlBinary) && /vid_38be&pid_0184/i.test(device.id) });
      initializationOperation = (async () => {
        if (status.calibrationSupported && /vid_38be&pid_0184/i.test(device.id)) {
          try {
            const calibration = await prepareCalibration(device);
            initializationStage(58, 'Loading temperature calibration...');
            factoryProcessor = createFactoryProcessor({ calibrationFolder: calibration.folder, expectedSerial: calibration.serial });
            calibrationBytes = fs.readFileSync(path.join(calibration.folder, 'thermometry-calibration.bin'));
            radiometry = createRadiometry(calibrationBytes, { serial: calibration.serial, environment: status.measurementEnvironment, generatedReference: true });
          } catch (error) {
            factoryProcessor = radiometry = calibrationBytes = null;
            publish({ calibrationError: error.message });
          }
        }
        if (closing) return;
        initializationStage(60, 'Opening camera stream…');
        const camera = new Camera(); bindSource(camera);
        const framesReady = waitForCameraFrames(camera, { onProgress: fraction => initializationStage(65 + Math.floor(fraction * 10), 'Waiting for stable camera frames…') });
        // Observe rejection even if start fails before we reach the await below.
        framesReady.catch(() => {});
        try {
          await camera.start(device.id);
          await framesReady;
          if (closing) return;
          if (status.shutterSupported) {
            initializationStage(80, 'Capturing shutter reference…');
            try { await captureShutterReference(); }
            catch (error) { publish({ error: error.message, message: 'Camera preview is ready, but the shutter reference failed. Retry using Auto calibrate.' }); }
          }
          if (source !== camera || !status.connected) throw new Error('Camera disconnected during initialization.');
          if (status.calibrationError) publish({ error: `Factory calibration unavailable: ${status.calibrationError}` });
          initializationStage(100, 'Camera ready');
        } catch (error) {
          if (source === camera) { source = null; camera.removeAllListeners('frame'); }
          await camera.stop();
          publish({ connected: false });
          throw error;
        }
      })();
      try { await initializationOperation; }
      finally { initializationOperation = null; publish({ connecting: false, initializationBusy: false, initializationProgress: null, initializationMessage: '' }); }

      return {};
    }
    case 'disconnect': await disconnect(); return {};
    case 'settings': {
      if (payload.resolution !== undefined && !['native','enhanced'].includes(payload.resolution)) throw new Error('Unknown preview resolution.');
      const visualChange = payload.palette !== undefined || payload.resolution !== undefined || payload.rotation !== undefined;
      if (visualChange) {
        lockedSettings();
        previewGeneration++;
        enhancer.cancel();
      }
      if (payload.logFrequencyHz !== undefined) {
        lockedSettings();
        if (![0.2, 0.5, 1, 2].includes(payload.logFrequencyHz)) throw new Error('Unsupported log frequency.');
        publish({ logFrequencyHz: payload.logFrequencyHz });
      }
      if (payload.temperatureUnit !== undefined || payload.measurementEnvironment !== undefined || payload.resolution !== undefined) {
        const environmentChanged = payload.measurementEnvironment !== undefined;
        let nextRadiometry = radiometry;
        const environment = environmentChanged ? validateMeasurementEnvironment(payload.measurementEnvironment) : status.measurementEnvironment;
        if (environmentChanged) {
          lockedSettings();
          if (calibrationBytes && radiometry) nextRadiometry = createRadiometry(calibrationBytes, { serial: radiometry.serial, environment, generatedReference: true, automaticReflectedC: radiometry.automaticReflectedC });
        }
        // Validate and persist before changing the live measurement state.
        const preferences = savePreferences(preferencesPath, { temperatureUnit: payload.temperatureUnit ?? status.temperatureUnit,
          previewResolution: payload.resolution ?? resolution, measurementEnvironment: environment });
        resolution = preferences.previewResolution;
        if (environmentChanged) {
          radiometry = nextRadiometry;
          temperatureSampler.reset();
          previewGeneration++;
          enhancer.cancel();
          const unavailable = { temperatures: null, calibration: { status: 'unavailable', reason: 'Measurement parameters changed; waiting for next sample.' }, environment: radiometry?.environment || { ...environment, ...(environment.reflectedManualOverride === false ? { reflectedC: null } : {}) } };
          if (latestInput) latestInput = { ...latestInput, generation: previewGeneration, nativeFrame: { ...latestInput.nativeFrame, ...unavailable } };
          if (latest) {
            latest = { ...latest, frame: { ...latest.frame, ...unavailable }, nativeFrame: { ...latest.nativeFrame, ...unavailable } };
            sendFrame();
          }
        }
        publish(preferences);
      }
      if (payload.palette !== undefined) {
        if (!['iron', 'inferno', 'gray', 'rainbow'].includes(payload.palette)) throw new Error('Unknown palette.');
        palette = payload.palette;
      }
      if (payload.rotation !== undefined) {
        if (![0, 90, 180, 270].includes(payload.rotation)) throw new Error('Invalid image rotation.');
        rotation = payload.rotation;
      }
      publish({ previewResolution: resolution, rotation });
      if (resolution === 'enhanced') enhancer.start();
      if (latestInput && visualChange) {
        const preview = decodeFrame(latestInput.raw, { flatField, factoryPlane: latestInput.factoryPlane, palette });
        latestInput = { ...latestInput, nativeFrame: { ...latestInput.nativeFrame, rgba: preview.rgba, displayGray: preview.displayGray, displayRange: preview.displayRange },
          generation: previewGeneration, palette, resolution, rotation };
        queuePreview(latestInput, true);
      }
      return {};
    }
    case 'shutter': {
      requireFrame(); lockedSettings();
      if (!status.shutterSupported || status.mode !== 'raw') throw new Error('Connect the SK02 on Windows to capture a shutter reference.');
      return await captureShutterReference();
    }
    case 'snapshot': {
      requireFrame();
      const folder = createFolder(status.outputDir, 'snapshot');
      const { frame, raw } = latest;
      const temperatures = validatedTemperatures(frame);
      // Electron's bitmap constructor expects BGRA on supported little-endian hosts.
      const bgra = Buffer.from(frame.rgba);
      for (let i = 0; i < bgra.length; i += 4) [bgra[i], bgra[i + 2]] = [bgra[i + 2], bgra[i]];
      const png = nativeImage.createFromBitmap(bgra, { width: frame.width, height: frame.height }).toPNG();
      fs.writeFileSync(path.join(folder, 'preview.png'), png);
      fs.writeFileSync(path.join(folder, 'sensor.raw'), raw);
      fs.writeFileSync(path.join(folder, 'measurement.json'), JSON.stringify({ profile: PROFILE, timestamp: new Date(frame.timestamp).toISOString(), source: status.source, mode: frame.mode, stats: frame.stats, temperatures, temperatureUnit: 'celsius', measurementSample: frame.measurementSample, environment: frame.environment || { ...status.measurementEnvironment, ...(status.measurementEnvironment.reflectedManualOverride === false ? { reflectedC: null } : {}) }, configuredEnvironment: status.measurementEnvironment, environmentSource: status.measurementEnvironment.reflectedManualOverride === false ? 'configured-with-automatic-reflection' : 'configured', displayTemperatureUnit: status.temperatureUnit, calibration: temperatures ? 'factory-calibrated' : 'unavailable', factoryCalibration: temperatures ? frame.calibration : null, displayTransform: frame.displayTransform, palette, flatField: !!flatField, reference: referenceInfo, cropStatus: 'apk-routine-verified-runtime-unverified' }, null, 2));
      if (flatField) fs.writeFileSync(path.join(folder, 'flat-field.f32'), Buffer.from(flatField.buffer, flatField.byteOffset, flatField.byteLength));
      publish({ message: `Snapshot saved: ${path.basename(folder)}` }); return { folder };
    }
    case 'recordStart':
    case 'logStart': {
      requireFrame();
      const video = name === 'recordStart';
      if (video ? recorder : logger) throw new Error('Already running.');
      const session = new Session(status.outputDir, { video, logFrequencyHz: status.logFrequencyHz, source: status.source, palette, flatField, reference: referenceInfo, environment: latest.frame.environment || radiometry?.environment || { ...status.measurementEnvironment, ...(status.measurementEnvironment.reflectedManualOverride === false ? { reflectedC: null } : {}) }, configuredEnvironment: status.measurementEnvironment, temperatureUnit: status.temperatureUnit, preview: { width: latest.frame.width, height: latest.frame.height, resolution, rotation, fps: 25 }, calibration: validatedTemperatures(latest.frame) ? latest.frame.calibration : null });
      session.on('session-error', error => { stopSessions(error.message).catch(() => {}); publish({ error: error.message }); });
      if (video) recorder = session; else logger = session;
      publish({ recording: !!recorder, logging: !!logger, error: null, message: video ? 'Recording MP4, full raw frames, and CSV.' : validatedTemperatures(latest.frame) ? 'Logging center, high, and low temperatures with detector measurements to CSV.' : 'Logging detector measurements to CSV. Celsius columns remain empty.' });
      return { folder: session.folder };
    }
    case 'recordStop':
    case 'logStop': {
      const session = name === 'recordStop' ? recorder : logger;
      if (name === 'recordStop') recorder = null; else logger = null;
      publish({ recording: !!recorder, logging: !!logger, message: 'Finishing capture files…' });
      const folder = session ? await finishSession(session) : null;
      publish({ message: folder ? `Saved: ${path.basename(folder)}` : 'Capture stopped.', error: session?.finalError || null });
      return { folder };
    }
    case 'replay': {
      const selected = await dialog.showOpenDialog(window, { title: 'Open SK02 raw recording', filters: [{ name: 'Raw SK02 frames', extensions: ['raw', 'yuyv', 'bin'] }], properties: ['openFile'] });
      if (selected.canceled) return { cancelled: true };
      await disconnect();
      publish({ connecting: true, source: path.basename(selected.filePaths[0]), mode: 'replay', frames: 0, error: null });
      const replay = new Replay(); bindSource(replay);
      try { await replay.start(selected.filePaths[0]); } catch (error) { source = null; publish({ connecting: false }); throw error; }
      return {};
    }
    case 'openOutput': fs.mkdirSync(status.outputDir, { recursive: true }); {
      const error = await shell.openPath(status.outputDir); if (error) throw new Error(error); return {};
    }
    default: throw new Error('Unknown action.');
  }
}

app.whenReady().then(() => {
  if (!primaryInstance) return;
  if (process.platform === 'win32') app.setAppUserModelId('local.caloraview.desktop');
  controlBinary = app.isPackaged ? path.join(process.resourcesPath, 'native', 'Caloraview.CameraControl.exe') : path.join(app.getAppPath(), 'build', 'native', 'Caloraview.CameraControl.exe');
  status.outputDir = process.env.CALORAVIEW_OUTPUT || path.join(app.getPath('videos'), 'Caloraview');
  calibrationRoot = process.env.CALORAVIEW_CALIBRATION_DIR || path.join(app.getPath('userData'), 'camera-calibration');
  preferencesPath = process.env.CALORAVIEW_PREFERENCES_PATH || path.join(app.getPath('userData'), 'preferences.json');
  Object.assign(status, loadPreferences(preferencesPath));
  resolution = status.previewResolution;
  status.calibrationSupported = controlAvailable(controlBinary);
  enhancer = new NeuralPreview();
  enhancer.on('state', patch => publish(patch));
  enhancer.on('frame', ({ job, result }) => presentPreview(job, result));
  enhancer.on('failure', reason => {
    publish({ message: `HD is using smooth scaling: ${typeof reason === 'string' ? reason : reason?.message || 'Neural enhancement unavailable.'}` });
    if (latestInput) presentPreview(latestInput);
  });
  window = new BrowserWindow({ width: 1280, height: 800, minWidth: 960, minHeight: 700, backgroundColor: '#101318', title: 'Caloraview Desktop', icon: path.join(__dirname, 'renderer', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ipcMain.on('caloraview:frame-ack', event => { if (event.sender === window.webContents) framePending = false; });
  ipcMain.handle('caloraview:action', async (event, name, payload) => {
    if (event.sender !== window.webContents) return { ok: false, error: 'Invalid sender.' };
    const readonly = name === 'state';
    if (!readonly && closing) return { ok: false, error: 'The app is finishing capture files and closing.' };
    if (!readonly && busy) return { ok: false, error: 'An operation is already in progress.' };
    if (!readonly) busy = true;
    try { return { ok: true, ...await action(name, payload) }; }
    catch (error) { publish({ error: error.message }); return { ok: false, error: error.message }; }
    finally { if (!readonly) busy = false; }
  });
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  window.on('close', event => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    Promise.resolve(initializationOperation).catch(() => {}).then(() => disconnect()).catch(error => console.error('Capture shutdown:', error.message)).then(() => enhancer?.close()).finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });
});
app.on('window-all-closed', () => app.quit());
