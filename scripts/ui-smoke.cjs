const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AI_METHODS = ['realesrgan-x4v3-display', 'fsrcnn-x2-display'];
function parseCsvLine(line) {
  const result = []; let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') { if (quoted && line[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (line[i] === ',' && !quoted) { result.push(value); value = ''; }
    else value += line[i];
  }
  assert.equal(quoted, false, 'Unclosed CSV quote'); result.push(value); return result;
}
async function waitForAi(page, width, height, timeout = 90000) {
  await page.waitForFunction(({ width, height, methods }) => {
    const canvas = document.querySelector('#thermal-canvas');
    const frame = window.samplingEvidence?.latest;
    return canvas.width === width && canvas.height === height
      && frame?.width === width && frame?.height === height
      && methods.includes(frame.transform?.method) && typeof frame.transform.model === 'string' && !!frame.transform.model
      && typeof frame.transform.provider === 'string' && !!frame.transform.provider;
  }, { width, height, methods: AI_METHODS }, { timeout });
}

(async () => {
  const output = path.resolve('test-output/ui');
  fs.mkdirSync(output, { recursive: true });
  const desktop = await electron.launch({
    ...(process.env.CALORAVIEW_TEST_PACKAGED ? { executablePath: path.resolve('dist/win-unpacked/Caloraview Desktop.exe'), args: [] } : { args: [path.resolve('.')] }),
    env: { ...process.env, CALORAVIEW_OUTPUT: output }
  });
  let page;
  try {
    page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => [...document.querySelectorAll('#device-select option')].some(o => /vid_38be&pid_0184/i.test(o.value)), null, { timeout: 15000 });
    const device = await page.locator('#device-select option').evaluateAll(options => options.find(o => /vid_38be&pid_0184/i.test(o.value)).value);
    await page.selectOption('#device-select', device);
    await page.click('#connect-btn');
    await page.waitForFunction(() => !document.querySelector('#initialization-overlay').hidden, null, { timeout: 5000 });
    await page.screenshot({ path: path.join(output, 'initializing-desktop.png'), fullPage: true });
    await page.waitForFunction(() => document.querySelector('#raw-center').textContent !== '—' && !document.querySelector('#snapshot-btn').disabled, null, { timeout: 90000 });
    const initialized = await page.evaluate(() => window.caloraview.invoke('state'));
    assert.equal(initialized.initializationBusy, false);
    assert.equal(initialized.connecting, false);
    assert.equal(initialized.error, null);
    assert.equal(initialized.calibrationDownloaded, true);
    assert.equal(await page.locator('#flat-field-state').innerText(), 'Reference active');
    assert.equal(await page.locator('#initialization-overlay').isHidden(), true);
    assert.equal(await page.locator('#download-calibration-btn').count(), 0);
    if (process.env.CALORAVIEW_TEST_CALIBRATION === '1') {
      assert.match(initialized.calibrationSerial, /^A43EB0_/);
      const validation = JSON.parse(fs.readFileSync(path.join(initialized.calibrationFolder, 'validation.json')));
      assert.equal(validation.valid, true);
      assert.equal(validation.files.length, 8);
    }
    await page.waitForFunction(() => /^-?\d/.test(document.querySelector('#temp-center').textContent), null, { timeout: 15000 });
    assert.equal(await page.locator('#flat-field-btn').count(), 0);
    assert.equal(await page.locator('#shutter-btn').innerText(), 'Auto calibrate');
    const temperatures = await page.locator('#temp-center').innerText();
    assert.equal(await page.locator('.factory-panel').count(), 0);
    assert.equal(await page.locator('#display-rendering').count(), 0);
    assert.equal(await page.locator('.session-bar').count(), 0);
    await page.selectOption('#log-frequency-select', '2');
    await page.evaluate(() => {
      window.samplingEvidence = { frames: 0, samples: [], models: {}, latest: null, leakedDisplayPlane: false };
      window.caloraview.onFrame(frame => {
        const evidence = window.samplingEvidence;
        evidence.frames++;
        evidence.latest = { width: frame.width, height: frame.height, sequence: frame.sequence, transform: frame.displayTransform };
        evidence.leakedDisplayPlane ||= 'displayGray' in frame || 'detector' in frame;
        if (frame.displayTransform?.model) evidence.models[frame.displayTransform.method] = frame.displayTransform;
        if (frame.temperatures && frame.measurementSample && !evidence.samples.some(sample => sample.sequence === frame.measurementSample.sequence)) {
          evidence.samples.push(frame.measurementSample);
        }
      });
    });
    await page.selectOption('#resolution-select', 'enhanced');
    await waitForAi(page, 512, 384);
    await page.click('#rotate-right-btn');
    await waitForAi(page, 384, 512);
    await page.click('#rotate-left-btn');
    await waitForAi(page, 512, 384);
    await page.selectOption('#resolution-select', 'native');
    await page.waitForFunction(() => document.querySelector('#thermal-canvas').width === 256 && window.samplingEvidence?.latest?.transform?.method === 'native');
    await page.selectOption('#resolution-select', 'enhanced');
    await waitForAi(page, 512, 384);
    await page.click('#rotate-right-btn');
    await waitForAi(page, 384, 512);

    // Start recording immediately after a geometry change, before AI can finish.
    // The synchronous correctly sized fallback must prevent encoder-size races.
    const immediateRecording = await page.evaluate(async () => {
      const changed = await window.caloraview.invoke('settings', {rotation:0});
      if (!changed.ok) return changed;
      return window.caloraview.invoke('recordStart');
    });
    assert.equal(immediateRecording.ok, true, immediateRecording.error);
    await waitForAi(page, 512, 384);
    await page.waitForTimeout(350);
    const immediateStop = await page.evaluate(() => window.caloraview.invoke('recordStop'));
    assert.equal(immediateStop.ok, true, immediateStop.error);
    const immediateMeta = JSON.parse(fs.readFileSync(path.join(immediateRecording.folder,'session.json')));
    assert.equal(immediateMeta.status,'complete');
    assert.equal(immediateMeta.preview.width,512); assert.equal(immediateMeta.preview.height,384);
    assert(immediateMeta.uniquePreviewFrames > 0);
    await page.click('#rotate-right-btn');
    await waitForAi(page,384,512);

    if (process.env.CALORAVIEW_TEST_SHUTTER === '1') {
      await page.click('#shutter-btn');
      await page.waitForFunction(() => document.querySelector('#flat-field-state').textContent !== 'Off' && !document.querySelector('#shutter-btn').disabled, null, { timeout: 20000 });
    }
    await waitForAi(page, 384, 512);
    await page.click('#snapshot-btn');
    await page.waitForFunction(() => !document.querySelector('#record-btn').disabled);
    const snapshotName = fs.readdirSync(output).filter(n => n.includes('-snapshot-')).sort().at(-1);
    const snapshot = JSON.parse(fs.readFileSync(path.join(output, snapshotName, 'measurement.json')));
    assert(AI_METHODS.includes(snapshot.displayTransform.method));
    assert(snapshot.displayTransform.model && snapshot.displayTransform.provider);
    await page.click('#record-btn');
    await page.waitForFunction(() => document.querySelector('#record-label').textContent === 'Stop recording');
    await page.waitForTimeout(3200);
    await page.screenshot({ path: path.join(output, 'live-desktop.png'), fullPage: true });
    await page.click('#record-btn');
    await page.waitForFunction(() => document.querySelector('#record-label').textContent === 'Record video' && !document.querySelector('#record-btn').disabled);
    await page.selectOption('#log-frequency-select', '1');
    await page.click('#log-btn');
    await page.waitForFunction(() => document.querySelector('#log-label').textContent === 'Stop logging');
    assert.equal(await page.locator('#log-frequency-select').isDisabled(), true);
    await page.waitForTimeout(2300);
    await page.click('#log-btn');
    await page.waitForFunction(() => document.querySelector('#log-label').textContent === 'Log CSV' && !document.querySelector('#connect-btn').disabled);
    await page.click('#connect-btn');
    await page.waitForFunction(() => document.querySelector('#connect-btn').textContent === 'Connect camera');
    const recording = fs.readdirSync(output).filter(n => n.includes('-recording-')).sort().at(-1);
    assert(recording);
    const folder = path.join(output, recording);
    const meta = JSON.parse(fs.readFileSync(path.join(folder, 'session.json')));
    assert.equal(meta.status, 'complete');
    assert.equal(meta.calibration, 'factory-calibrated');
    assert.equal(meta.preview.width, 384);
    assert.equal(meta.preview.height, 512);
    assert([15,25].includes(meta.preview.fps));
    const previewCsv = fs.readFileSync(path.join(folder, 'preview-frames.csv'), 'utf8').trim().split(/\r?\n/).map(parseCsvLine);
    const previewNames = previewCsv.shift();
    const field = (row, name) => row[previewNames.indexOf(name)];
    assert.equal(previewCsv.length, meta.videoFrames);
    assert.equal(previewCsv.filter(row => field(row, 'repeat') === '0').length, meta.uniquePreviewFrames);
    assert(meta.uniquePreviewFrames > 0 && meta.frames >= meta.uniquePreviewFrames);
    assert(meta.videoFrames >= meta.uniquePreviewFrames);
    for (let i = 0; i < previewCsv.length; i++) {
      const row = previewCsv[i];
      assert(AI_METHODS.includes(field(row, 'method')), 'Recording silently used non-AI enhancement');
      assert(field(row, 'model') && field(row, 'provider'), 'Missing runtime model/provider provenance');
      assert.equal(Number(field(row, 'video_frame')), i + 1);
      assert(Math.abs(Number(field(row, 'video_time_ms')) - i * 1000 / meta.preview.fps) < .001);
      assert(Number(field(row, 'raw_frame')) >= 1 && Number(field(row, 'raw_frame')) <= meta.frames);
      if (i && field(row, 'repeat') === '1') {
        for (const key of ['source_sequence','raw_frame','timestamp_utc','method','model','provider']) assert.equal(field(row,key),field(previewCsv[i-1],key),'Repeated video slot changed source provenance');
      } else if (i) assert(Number(field(row,'source_sequence')) > Number(field(previewCsv[i-1],'source_sequence')));
    }
    assert(fs.statSync(path.join(folder, 'preview.mp4')).size > 1000);
    const csv = fs.readFileSync(path.join(folder, 'measurements.csv'), 'utf8').trim().split('\n').map(row => row.split(','));
    const names = csv.shift();
    const calibrated = csv.filter(row => row[names.indexOf('calibration_status')] === 'factory-calibrated');
    assert(calibrated.length >= 5 && calibrated.length <= 9, `Expected about 2 samples/second, got ${calibrated.length}`);
    assert.equal(meta.logFrequencyHz, 2);
    assert.equal(meta.measurementRows, csv.length);
    for (const row of calibrated) {
      assert.equal(row[names.indexOf('room_temperature_c')], '20');
      assert.equal(row[names.indexOf('room_temperature_f')], '68');
      assert.equal(row[names.indexOf('relative_humidity_percent')], '60');
    }
    const evidence = await page.evaluate(() => window.samplingEvidence);
    assert(evidence.frames > evidence.samples.length * 2, 'Preview should remain faster than temperature sampling');
    assert.equal(evidence.leakedDisplayPlane, false, 'Full inference/detector planes leaked into renderer IPC');
    for (const row of previewCsv) {
      const runtime = evidence.models[field(row, 'method')]; assert(runtime);
      assert.equal(field(row, 'model'), runtime.model); assert.equal(field(row, 'provider'), runtime.provider);
    }
    const first = calibrated[0], last = calibrated.at(-1);
    const captureHz = (Number(last[names.indexOf('sequence')]) - Number(first[names.indexOf('sequence')])) * 1000 /
      (Number(last[names.indexOf('elapsed_ms')]) - Number(first[names.indexOf('elapsed_ms')]));
    assert(captureHz >= 20 && captureHz <= 30, 'Raw capture no longer near25 Hz: ' + captureHz);
    fs.writeFileSync(path.join(output,'enhancement-evidence.json'),JSON.stringify({models:evidence.models,captureHz,rawFrames:meta.frames,uniquePreviewFrames:meta.uniquePreviewFrames,videoFrames:meta.videoFrames},null,2));
    for (let i = 1; i < evidence.samples.length; i++) {
      const delta = evidence.samples[i].monotonicMs - evidence.samples[i-1].monotonicMs;
      assert(delta >= 400, `Temperature samples arrived only ${delta}ms apart`);
    }
    const logName = fs.readdirSync(output).filter(n => n.includes('-log-')).sort().at(-1);
    const logMeta = JSON.parse(fs.readFileSync(path.join(output, logName, 'session.json')));
    assert.equal(logMeta.logFrequencyHz, 1);
    assert(logMeta.measurementRows >= 2 && logMeta.measurementRows <= 3);
    assert(logMeta.frames > logMeta.measurementRows * 5);
    for (const row of calibrated) for (const name of ['center_c','high_c','low_c']) assert(Number.isFinite(Number(row[names.indexOf(name)])) && row[names.indexOf(name)] !== '');

    assert(meta.frames >= 20);
    assert.equal(fs.statSync(path.join(folder, 'sensor.raw')).size, meta.frames * 117216);
    const rawFile = path.join(folder, 'sensor.raw');
    await desktop.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, rawFile);
    await page.click('#replay-btn');
    await page.waitForFunction(() => document.querySelector('#view-mode').textContent.includes('REPLAY'));
    await page.waitForFunction(() => document.querySelector('#connect-btn').textContent === 'Connect camera', null, { timeout: 15000 });
    await page.setViewportSize({ width: 960, height: 700 });
    await page.screenshot({ path: path.join(output, 'compact-desktop.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'passed', frames: meta.frames, uniquePreviewFrames: meta.uniquePreviewFrames, videoFrames: meta.videoFrames, models: evidence.models, captureHz, temperatures, calibratedRows: calibrated.length, output, recording: folder, rendererErrors: errors }));
  } catch (error) {
    if (page && !page.isClosed()) {
      console.error('App state:', await page.evaluate(() => window.caloraview.invoke('state')));
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
    }
    throw error;
  } finally { await desktop.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
