'use strict';

const api = window.caloraview;
const $ = (id) => document.getElementById(id);
const state = { connected: false, connecting: false, recording: false, logging: false, source: '', frames: 0 };
let latestFrame = null;
let pendingFrame = null;
let animationPending = false;
let actionPending = false;
let history = [];
let lastHistoryTime = 0;
let frameTimes = [];
let lastFrameArrival = 0;
let recordStarted = 0;
let toastTimer;
let parameterUnit = 'C';
let parameterTemperatures={},renderedTemperatures={};
let parameterDistanceMeters=.9144,parameterDistanceUnit='m',renderedDistance='';
const emissivityPresets={'ice-water':.95,pcb:.91,concrete:.95,ceramics:.92,paint:.93,wood:.85,asphalt:.96,brick:.95,sand:.90,soil:.92,cotton:.98,cardboard:.90,'white-paper':.90,water:.96};
const defaultEnvironment = {emissivityPreset:'custom',emissivity:.91,distanceMeters:.9144,ambientC:20,reflectedC:20,reflectedManualOverride:false,humidityPercent:60};
const chartColors = { center: '#dce4ee', high: '#ff996b', low: '#73b9ec' };
const controls = ['connect-btn', 'refresh-btn', 'snapshot-btn', 'record-btn', 'log-btn', 'replay-btn'];

function setStatus(message, error = false) {
  $('status-message').textContent = message;
  $('status-message').classList.toggle('error', error);
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 8000 : 4500);
  setStatus(message, error);
}

async function call(action, payload, { success, quiet = false } = {}) {
  if (!api) { if (!quiet) toast('The desktop connection is unavailable. Start Caloraview through its desktop launcher.', true); return null; }
  try {
    const result = await api.invoke(action, payload);
    if (result?.ok === false) throw new Error(result.error || `${action} failed`);
    if (result?.status) updateStatus(result.status);
    if (success && !result?.cancelled) toast(typeof success === 'function' ? success(result) : success);
    return result;
  } catch (error) {
    if (!quiet) toast(error.message || String(error), true);
    return null;
  }
}

async function runAction(action, payload, options) {
  if (actionPending) return null;
  actionPending = true;
  updateControls();
  try { return await call(action, payload, options); }
  finally { actionPending = false; updateControls(); }
}

function parametersLocked() { return Boolean(actionPending||state.recording||state.logging||state.initializationBusy||state.connecting||state.calibrationBusy||state.shutterBusy||state.busy); }
function updateControls() {
  $('measurement-parameters-btn').disabled=parametersLocked();
  $('measurement-parameters-apply').disabled=parametersLocked();
  $('measurement-parameters-cancel').disabled=actionPending;
  const active = state.connected && !state.connecting;
  const hasFrame = active && latestFrame !== null;
  const calibrationBusy = Boolean(state.calibrationBusy);
  const setupBusy = Boolean(state.initializationBusy || state.connecting || calibrationBusy);
  const logHz=[.2,.5,1,2].includes(state.logFrequencyHz)?state.logFrequencyHz:2;
  $('log-frequency-select').value=String(logHz);
  $('log-frequency-select').disabled=actionPending||state.recording||state.logging||setupBusy;
  $('log-capture-description').textContent=(state.recording||state.logging?'CSV active · every '+(1/logHz)+' s. ':'')+'Room temperature and RH are logged from configured environment values.';
  $('connect-btn').disabled = actionPending || state.connecting || (!state.connected && !$('device-select').value);
  $('connect-btn').textContent = state.connecting ? calibrationBusy ? 'Preparing camera…' : 'Connecting…' : state.connected ? 'Disconnect' : 'Connect camera';
  $('connect-btn').classList.toggle('primary', !state.connected);
  $('device-select').disabled = state.connected || state.connecting || actionPending;
  $('refresh-btn').disabled = state.connected || state.connecting || actionPending;
  $('replay-btn').disabled = state.connected || state.connecting || actionPending;
  $('snapshot-btn').disabled = !hasFrame || actionPending;
  $('record-btn').disabled = !hasFrame || actionPending;
  $('log-btn').disabled = !hasFrame || actionPending || state.recording;
  $('shutter-btn').disabled = !hasFrame || actionPending || state.recording || state.logging || !state.shutterSupported || state.shutterBusy;
  $('shutter-btn').textContent = state.shutterBusy ? 'Calibrating…' : 'Auto calibrate';
  $('shutter-btn').title = 'Refresh device factory correction with a new internal shutter reference.';
  for (const id of ['resolution-select','rotate-left-btn','rotate-right-btn']) $(id).disabled = actionPending || state.recording || state.logging || state.shutterBusy;
  $('resolution-select').value = state.previewResolution || 'native';
  $('rotate-left-btn').title = 'Rotate preview left · current '+(state.rotation||0)+'°';
  $('rotate-right-btn').title = 'Rotate preview right · current '+(state.rotation||0)+'°';
  $('palette-select').disabled = actionPending || state.recording || state.logging;
  $('temperature-unit-select').value=state.temperatureUnit==='F'?'F':'C';
  $('record-btn').classList.toggle('active', state.recording);
  $('record-label').textContent = state.recording ? 'Stop recording' : 'Record video';
  $('log-label').textContent = state.recording ? 'CSV included' : state.logging ? 'Stop logging' : 'Log CSV';
  $('log-btn').classList.toggle('active', state.logging);
  if (setupBusy) {
    for (const id of [...controls, 'shutter-btn', 'device-select', 'palette-select', 'resolution-select', 'rotate-left-btn', 'rotate-right-btn']) $(id).disabled = true;
  }
}

function updateInitialization() {
  const busy = Boolean(state.initializationBusy || state.connecting || state.calibrationBusy);
  const overlay = $('initialization-overlay');
  overlay.hidden = !busy;
  $('viewport').setAttribute('aria-busy', String(busy));
  if (!busy) return;
  $('initialization-message').textContent = state.initializationMessage || (state.calibrationBusy ? 'Checking saved factory files…' : 'Waiting for the camera stream…');
  const progress = $('initialization-progress');
  if (Number.isFinite(state.initializationProgress)) {
    const value = Math.max(0, Math.min(100, state.initializationProgress));
    progress.value = value;
    $('initialization-percent').textContent = Math.round(value) + '%';
  } else {
    progress.removeAttribute('value');
    $('initialization-percent').textContent = 'Working…';
  }
}

function updateStatus(next) {
  if (!next || typeof next !== 'object') return;
  const wasConnected = state.connected;
  const wasRecording = state.recording;
  Object.assign(state, next);
  if ($('measurement-parameters-dialog').open && !$('env-reflected-manual').checked) renderReflectedParameter();
  updateInitialization();
  if (state.recording && !wasRecording) recordStarted = Date.now();
  if (!state.recording) recordStarted = 0;
  const replaying = state.mode === 'replay' && state.connected;
  $('connection-pill').className = `connection-pill${state.connected ? ' connected' : ''}${state.connecting ? ' connecting' : ''}`;
  $('connection-pill').lastElementChild.textContent = state.connecting ? state.calibrationBusy ? 'Preparing camera' : 'Connecting' : state.connected ? (replaying ? 'Replay active' : 'Camera connected') : 'Disconnected';
  $('record-badge').hidden = !state.recording;
  $('logging-indicator').hidden = !state.logging && !state.recording;
  if (!state.connected && wasConnected) {
    frameTimes = [];
    $('stream-badge').hidden = true;
    $('frame-rate').textContent = '— fps';
    if (latestFrame) { $('view-mode').textContent = 'LAST FRAME'; $('correction-info').textContent = 'CAPTURE STOPPED'; }
  }
  if (state.connected && !wasConnected) {
    history = [];
    frameTimes = [];
    latestFrame = null;
    lastHistoryTime = 0;
  }
  updateMeasurements();
  paintMarkers();
  updateDisplayRendering();
  if (next.error) toast(String(next.error), true);
  else if (next.message) setStatus(next.message);
  else if (state.connecting) setStatus(state.calibrationBusy ? 'Checking saved factory files before opening the camera stream…' : 'Opening the camera stream…');
  else if (state.connected && !wasConnected) setStatus('Receiving detector frames. Preparing factory correction and temperature measurements.');
  else if (!state.connected && wasConnected) setStatus('Capture stopped. The last received frame remains visible.');
  updateControls();
}

function temperatureUnit(){return state.temperatureUnit==='F'?'°F':'°C';}
function displayTemperature(value){return state.temperatureUnit==='F'?value*9/5+32:value;}
function temperatureText(value) {
  return Number.isFinite(value) ? displayTemperature(value).toFixed(1) : '—';
}

function showTemperature(id, value) {
  const element = $(id);
  const text=temperatureText(value);
  element.classList.toggle('compact-value',text.length>=5);
  element.replaceChildren(document.createTextNode(text));
  const unit = document.createElement('small');
  unit.textContent = temperatureUnit();
  element.append(unit);
}

function hasTemperatures(frame=latestFrame) {
  return Boolean(frame && frame.calibration?.status === 'factory-calibrated' && ['center','high','low'].every(key=>Number.isFinite(frame.temperatures?.[key])));
}
function updateMeasurements() {
  const frame=latestFrame;
  const referencing=Boolean(state.initializationBusy||state.connecting||state.calibrationBusy||state.shutterBusy);
  const ready=!referencing&&hasTemperatures(frame);
  const calibration=frame?.calibration;
  for(const key of ['center','high','low'])showTemperature('temp-'+key,ready?frame.temperatures[key]:null);
  const title=$('calibration-notice-title'),detail=$('calibration-notice-detail'),notice=$('calibration-notice');
  notice.hidden=false;notice.classList.toggle('ready',ready);title.hidden=ready;
  if(referencing){title.textContent=state.shutterBusy?'Updating shutter reference':'Preparing measurements';detail.textContent='Temperatures resume after camera setup completes.';notice.title=state.initializationMessage||'Camera calibration and shutter reference are in progress.';}
  else if(ready){
    const e=calibration.environment||{};
    title.textContent='';
    const value=(v,suffix='')=>Number.isFinite(v)?String(Number(v.toFixed(2)))+suffix:'—';
    detail.textContent='ε '+value(e.emissivity)+' · air '+value(Number.isFinite(e.ambientC)?displayTemperature(e.ambientC):NaN,temperatureUnit())+' · '+value(e.distanceMeters,' m')+' · RH '+value(e.humidityPercent,'%');
    notice.title='Environmental assumptions: emissivity '+value(e.emissivity)+', ambient '+value(Number.isFinite(e.ambientC)?displayTemperature(e.ambientC):NaN,temperatureUnit())+', reflected '+value(Number.isFinite(e.reflectedC)?displayTemperature(e.reflectedC):NaN,temperatureUnit())+', humidity '+value(e.humidityPercent,'%')+', distance '+value(e.distanceMeters,' m')+'. '+(calibration.reason||'');
  }else{
    title.textContent=calibration?.status==='out-of-range'?'Temperature out of range':frame?'Temperature unavailable':'Waiting for camera';
    detail.textContent=calibration?.reason||(frame?'Detector counts are shown while valid Celsius data is unavailable.':'Factory files and shutter reference prepare automatically.');
    notice.title=detail.textContent;
  }
  notice.setAttribute('aria-label',(title.textContent?title.textContent+'. ':'')+notice.title);
  if(frame){
    $('view-mode').textContent=!state.connected?'LAST FRAME':referencing?'REFERENCING':ready?(frame.mode==='replay'?'REPLAY '+temperatureUnit():'FACTORY '+temperatureUnit()):frame.factoryCorrected?'CORRECTED PREVIEW':frame.mode==='replay'?'RAW REPLAY':'RAW PREVIEW';
    $('correction-info').textContent=!state.connected?'CAPTURE STOPPED':frame.factoryCorrected?'FACTORY CORRECTED':frame.flatField?'FLAT FIELD · VISUAL ONLY':'UNCORRECTED DETECTOR';
    $('flat-field-state').textContent=state.shutterBusy?'Referencing':frame.factoryCorrected?'Reference active':'Awaiting reference';
    $('correction-description').textContent=frame.factoryCorrected?'Device factory correction + internal shutter reference':'Factory files and shutter reference prepare automatically';
    $('thermal-canvas').setAttribute('aria-label',ready?'Thermal image with factory temperature measurements':frame.factoryCorrected?'Factory-corrected detector image':'Raw thermal detector image');
  }
  if(state.outputDir)$('output-btn').title=state.outputDir;
}

function onFrame(frame) {
  if (!frame || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width > 2048 || frame.height > 2048) return;
  if (!frame.rgba || frame.rgba.length !== frame.width * frame.height * 4) return;
  pendingFrame = frame;
  const now = performance.now();
  lastFrameArrival = now;
  frameTimes.push(now);
  while (frameTimes.length && frameTimes[0] < now - 1500) frameTimes.shift();
  if (!animationPending) {
    animationPending = true;
    requestAnimationFrame(() => { animationPending = false; if (pendingFrame) { paintFrame(pendingFrame); pendingFrame = null; } });
  }
}

function updateDisplayRendering() {
  const frame=latestFrame, transform=frame?.displayTransform||{};
  const method=transform.method;
  const aiMethods={'realesrgan-x4v3-display':'Real-ESRGAN x4v3','fsrcnn-x2-display':'FSRCNN x2'};
  const ai=Object.hasOwn(aiMethods,method);
  const enhanced=method==='native'?false:ai||method==='bounded-bicubic-display'||(transform.resolution||state.previewResolution)==='enhanced';
  const modeControl=$('resolution-select'),canvas=$('thermal-canvas');
  canvas.dataset.resolution=enhanced?'enhanced':'native';
  modeControl.dataset.method=method||'unspecified';
  if(frame){
    const model=typeof transform.model==='string'?transform.model:aiMethods[method];
    const provider=typeof transform.provider==='string'?' · '+transform.provider:'';
    let help=!enhanced?'Crisp '+frame.width+'×'+frame.height+' detector pixels. The preview fits the same window in either mode.':
      ai?model+provider+' · '+frame.width+'×'+frame.height+' AI display enhancement. Estimated image detail does not add temperature measurements.':
      'Smooth '+frame.width+'×'+frame.height+' display interpolation. No AI detail is added.';
    if(enhanced)help+=' Temperatures and markers use the native detector measurements.';
    if(transform.fallbackReason)help+=' Fallback: '+String(transform.fallbackReason);
    modeControl.title=help;canvas.title=help;
  }
  const pending=$('enhancement-status');
  const requested=state.previewResolution==='enhanced'&&state.connected;
  const loading=requested&&state.enhancementState==='loading';
  const fallback=requested&&state.enhancementState==='fallback';
  pending.hidden=!loading&&!fallback;
  pending.textContent=loading?'HD loading…':fallback?'HD fallback':'';
  pending.classList.toggle('fallback',fallback);
  pending.title=state.enhancementMessage||(loading?'Preparing image enhancement. Preview and temperature measurements remain active.':fallback?'AI enhancement is unavailable. Display interpolation remains active.':'');
}

function paintFrame(frame) {
  const previous = latestFrame;
  latestFrame = frame;
  const canvas = $('thermal-canvas');
  if (canvas.width !== frame.width || canvas.height !== frame.height) { canvas.width = frame.width; canvas.height = frame.height; }
  const overlay=$('overlay-canvas');
  const overlayScale=768/Math.max(frame.width,frame.height),overlayWidth=Math.round(frame.width*overlayScale),overlayHeight=Math.round(frame.height*overlayScale);
  if(overlay.width!==overlayWidth||overlay.height!==overlayHeight){overlay.width=overlayWidth;overlay.height=overlayHeight;}
  updateDisplayRendering();
  const pixels = new Uint8ClampedArray(frame.rgba);
  canvas.getContext('2d', { alpha: false }).putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
  $('empty-state').hidden = true;
  $('image-stage').hidden = false;
  $('viewport-bottom').hidden = false;
  $('stream-badge').hidden = false;
  $('stream-badge').replaceChildren();
  $('stream-badge').append(document.createElement('i'), document.createTextNode(frame.mode === 'replay' ? ' REPLAY' : ' LIVE'));
  $('frame-info').textContent = `FRAME ${String(frame.sequence ?? state.frames).padStart(6, '0')}`;
  const stats = frame.stats || {};
  for (const key of ['center', 'high', 'low']) {
    $(`raw-${key}`).textContent = Number.isFinite(stats[key]) ? Math.round(stats[key]).toLocaleString() : '—';
  }
  updateMeasurements();
  paintMarkers();
  if (performance.now() - lastHistoryTime >= 100 && ['center', 'high', 'low'].every((key) => Number.isFinite(stats[key]))) {
    history.push({ time: performance.now(), center: stats.center, high: stats.high, low: stats.low });
    if (history.length > 300) history.shift();
    lastHistoryTime = performance.now();
    paintChart();
  }
  if (!previous || Boolean(previous.flatField) !== Boolean(frame.flatField) || Boolean(previous?.factoryCorrected) !== Boolean(frame.factoryCorrected)) updateControls();
}

function paintMarkers() {
  const canvas = $('overlay-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!latestFrame || !$('markers-toggle').checked) return;
  const { width, height, stats = {} } = latestFrame;
  const cssScale=Math.min(canvas.clientWidth/canvas.width,canvas.clientHeight/canvas.height);
  if(!cssScale)return;
  const drawingScale=1/cssScale;
  const mark = (x, y, color, label) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height) return;
    const px = (x + .5) / width * canvas.width;
    const py = (y + .5) / height * canvas.height;
    ctx.save(); ctx.setTransform(drawingScale,0,0,drawingScale,px,py); ctx.strokeStyle = color; ctx.lineWidth = 1.7; ctx.shadowBlur = 3*drawingScale; ctx.shadowColor = '#000';
    ctx.beginPath(); ctx.moveTo(-11,0); ctx.lineTo(-4,0); ctx.moveTo(4,0); ctx.lineTo(11,0); ctx.moveTo(0,-11); ctx.lineTo(0,-4); ctx.moveTo(0,4); ctx.lineTo(0,11); ctx.stroke();
    ctx.strokeRect(-4,-4,8,8);
    ctx.font = '10px Segoe UI, sans-serif'; ctx.fillStyle = color;
    const labelWidth = ctx.measureText(label).width;
    const preferredX = (canvas.width-px)/drawingScale >= labelWidth+19 ? 14 : -14-labelWidth;
    const lx = Math.min((canvas.width-px)/drawingScale-labelWidth-5,Math.max(5-px/drawingScale,preferredX));
    const preferredY = py/drawingScale >= 22 ? -9 : 20;
    const ly = Math.min((canvas.height-py)/drawingScale-8,Math.max(13-py/drawingScale,preferredY));
    ctx.fillText(label, lx, ly); ctx.restore();
  };
  const referencing=state.initializationBusy||state.connecting||state.calibrationBusy||state.shutterBusy;
  const ready=hasTemperatures(latestFrame)&&!referencing;
  const label=key=>ready?`${displayTemperature(latestFrame.temperatures[key]).toFixed(1)}${temperatureUnit()}`:'—';
  const points=ready?latestFrame.temperatures:stats;
  const mapped=latestFrame.displayMarkers;
  const compatible=mapped&&(!mapped.source||mapped.source===(ready?'temperature':'detector'));
  canvas.dataset.markerSource=referencing?'reference':ready?'temperature':'detector';
  if(!referencing){mark(compatible?mapped.high?.x:points.highX,compatible?mapped.high?.y:points.highY,'#ffac73',label('high'));mark(compatible?mapped.low?.x:points.lowX,compatible?mapped.low?.y:points.lowY,'#75c8ff',label('low'));}
  mark(mapped?.center?.x??Math.floor(width/2),mapped?.center?.y??Math.floor(height/2),'#ffffff',label('center'));
}

function paintChart() {
  const canvas = $('trace-canvas');
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, width, height);
  const left = 38, right = width - 3, top = 8, bottom = height - 10;
  const values = history.flatMap((p) => [p.low, p.high, p.center]);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 10000;
  const padding = Math.max(5, (hi - lo) * .12);
  const min = Math.max(0, lo - padding), max = hi + padding;
  ctx.font = '8px Consolas, monospace';
  for (let i = 0; i < 3; i++) {
    const y = top + (bottom - top) * i / 2;
    ctx.strokeStyle = '#2a3037'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.fillStyle = '#657180'; ctx.textAlign = 'right'; ctx.fillText(Math.round(max - (max - min) * i / 2).toLocaleString(), left - 7, y + 3);
  }
  ctx.setLineDash([]);
  $('chart-empty').hidden = history.length > 0;
  if (!history.length) return;
  for (const key of ['high', 'low', 'center']) {
    ctx.strokeStyle = chartColors[key]; ctx.lineWidth = 1.3; ctx.beginPath();
    history.forEach((point, index) => {
      const x = right - (history.length - 1 - index) / 299 * (right - left);
      const y = bottom - (point[key] - min) / (max - min) * (bottom - top);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

async function scanDevices() {
  if (actionPending) return;
  actionPending = true;
  updateControls();
  try {
  const previous = $('device-select').value;
  const result = await call('devices');
  const devices = result?.devices || [];
  const select = $('device-select');
  select.replaceChildren();
  if (!devices.length) select.add(new Option('No supported camera found', ''));
  else for (const device of devices) select.add(new Option(device.name, String(device.id)));
  if (devices.some((d) => String(d.id) === previous)) select.value = previous;
  else {
    const thermal = devices.find((d) => /vid_38be&pid_0184/i.test(String(d.id))) || devices.find((d) => /^UVC Camera$/i.test(d.name));
    if (thermal) select.value = String(thermal.id);
  }
  } finally { actionPending = false; updateControls(); }
}

$('device-select').addEventListener('change', updateControls);
$('refresh-btn').addEventListener('click', scanDevices);
$('connect-btn').addEventListener('click', async () => {
  if (state.connected) await runAction('disconnect');
  else {
    const device = $('device-select').value;
    if (!device) return;
    await runAction('connect', { device });
  }
});
$('snapshot-btn').addEventListener('click', () => runAction('snapshot', undefined, { success: 'Image, available Celsius and original raw frame saved.' }));
$('record-btn').addEventListener('click', () => runAction(state.recording ? 'recordStop' : 'recordStart', undefined, { success: state.recording ? 'Recording saved.' : 'Recording started. Raw frames and CSV with available Celsius are included.' }));
$('log-btn').addEventListener('click', () => runAction(state.logging ? 'logStop' : 'logStart', undefined, { success: state.logging ? 'CSV log saved.' : 'CSV logging started. Counts and available Celsius are included.' }));
$('replay-btn').addEventListener('click', () => runAction('replay'));
$('output-btn').addEventListener('click', () => call('openOutput'));
$('shutter-btn').addEventListener('click', () => runAction('shutter'));
$('temperature-unit-select').addEventListener('change', () => runAction('settings',{temperatureUnit:$('temperature-unit-select').value}));
$('log-frequency-select').addEventListener('change', () => runAction('settings',{logFrequencyHz:Number($('log-frequency-select').value)}));
function openMeasurementParameters() {
  if(parametersLocked())return;
  const environment=state.measurementEnvironment||defaultEnvironment;
  parameterUnit=state.temperatureUnit==='F'?'F':'C';
  const convert=value=>parameterUnit==='F'?value*9/5+32:value;
  $('env-material').value=environment.emissivityPreset||'custom';
  parameterDistanceMeters=environment.distanceMeters;
  parameterDistanceUnit=parameterUnit==='F'?'ft':'m';
  $('env-distance-unit').value=parameterDistanceUnit;
  renderParameterDistance();
  for(const [id,key] of [['env-emissivity','emissivity'],['env-humidity','humidityPercent']])$(id).value=environment[key];
  for(const [id,key] of [['env-ambient','ambientC'],['env-reflected','reflectedC']]){
    $(id).min=-40;$(id).max=parameterUnit==='F'?212:100;
    parameterTemperatures[key]=environment[key];
    $(id).value=Number(convert(environment[key]).toFixed(6));
    renderedTemperatures[key]=$(id).value;
  }
  for(const label of document.querySelectorAll('.environment-temperature-unit'))label.textContent='(°'+parameterUnit+')';
  $('env-reflected-manual').checked=environment.reflectedManualOverride===true;
  renderReflectedParameter();
  $('measurement-parameters-error').hidden=true;
  $('measurement-parameters-dialog').showModal();
}
function renderReflectedParameter() {
  const manual=$('env-reflected-manual').checked, field=$('env-reflected');
  field.disabled=!manual;field.required=manual;
  const value=manual?parameterTemperatures.reflectedC:state.connected?state.automaticReflectedC:null;
  field.value=Number.isFinite(value)?Number((parameterUnit==='F'?value*9/5+32:value).toFixed(manual?6:1)):'';
  field.placeholder='Waiting for camera';
  // Automatic estimates can exceed the user-input range; the disabled field
  // displays them without silently clipping the calibrated sensor estimate.
  renderedTemperatures.reflectedC=field.value;
  $('env-reflected-help').textContent=manual?'Use your measured reflected temperature.':'Automatic estimate, retained until the camera reconnects.';
}
$('env-reflected-manual').addEventListener('change',()=>{
  // Preserve edited manual values when switching back to automatic.
  if(!$('env-reflected-manual').checked){
    const field=$('env-reflected');
    if(Number.isFinite(field.valueAsNumber))parameterTemperatures.reflectedC=field.value===renderedTemperatures.reflectedC?parameterTemperatures.reflectedC:parameterUnit==='F'?(field.valueAsNumber-32)*5/9:field.valueAsNumber;
  }
  renderReflectedParameter();
});
function readParameterDistance(){
  if($('env-distance').value===renderedDistance)return parameterDistanceMeters;
  const value=$('env-distance').valueAsNumber;
  return parameterDistanceUnit==='ft'?Math.round(value*.3048*1e12)/1e12:value;
}
function renderParameterDistance(){
  const feet=parameterDistanceUnit==='ft',field=$('env-distance');
  field.min=feet?.1/.3048:.1;field.max=feet?100/.3048:100;
  field.value=Number.isFinite(parameterDistanceMeters)?Number((feet?parameterDistanceMeters/.3048:parameterDistanceMeters).toFixed(8)):'';
  renderedDistance=field.value;
}
$('env-distance-unit').addEventListener('change',()=>{parameterDistanceMeters=readParameterDistance();parameterDistanceUnit=$('env-distance-unit').value;renderParameterDistance();});
$('env-material').addEventListener('change',()=>{const preset=$('env-material').value;if(Object.hasOwn(emissivityPresets,preset))$('env-emissivity').value=emissivityPresets[preset];});
$('env-emissivity').addEventListener('input',()=>{$('env-material').value='custom';});
$('measurement-parameters-btn').addEventListener('click',openMeasurementParameters);
$('measurement-parameters-cancel').addEventListener('click',()=>$('measurement-parameters-dialog').close());
$('measurement-parameters-form').addEventListener('submit',async event=>{
  event.preventDefault();
  if(parametersLocked()||!event.currentTarget.reportValidity())return;
  const celsius=(id,key)=>$(id).value===renderedTemperatures[key]?parameterTemperatures[key]:parameterUnit==='F'?($(id).valueAsNumber-32)*5/9:$(id).valueAsNumber;
  const measurementEnvironment={emissivityPreset:$('env-material').value,emissivity:$('env-emissivity').valueAsNumber,distanceMeters:readParameterDistance(),
    ambientC:celsius('env-ambient','ambientC'),reflectedC:$('env-reflected-manual').checked?celsius('env-reflected','reflectedC'):parameterTemperatures.reflectedC,
    reflectedManualOverride:$('env-reflected-manual').checked,humidityPercent:$('env-humidity').valueAsNumber};
  const result=await runAction('settings',{measurementEnvironment});
  if(result)$('measurement-parameters-dialog').close();
  else{$('measurement-parameters-error').textContent='Parameters could not be saved. Check the values and try again.';$('measurement-parameters-error').hidden=false;}
});

$('resolution-select').addEventListener('change', () => runAction('settings',{resolution:$('resolution-select').value}));
$('rotate-left-btn').addEventListener('click', () => runAction('settings',{rotation:((state.rotation||0)+270)%360}));
$('rotate-right-btn').addEventListener('click', () => runAction('settings',{rotation:((state.rotation||0)+90)%360}));
$('markers-toggle').addEventListener('change', paintMarkers);
$('palette-select').addEventListener('change', async () => {
  const palette = $('palette-select').value;
  const ramps = { iron: 'linear-gradient(90deg,#070524,#711783,#d94032,#ffa530,#fff5ba)', inferno: 'linear-gradient(90deg,#000004,#57106e,#bc3754,#f98e09,#fcffa4)', gray: 'linear-gradient(90deg,#111,#fff)', rainbow: 'linear-gradient(90deg,#5426a9,#1284dc,#1fce96,#e1dc40,#e84932)' };
  $('palette-ramp').style.background = ramps[palette];
  await call('settings', { palette });
});
window.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || /INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName)) return;
  const id = event.key.toLowerCase() === 's' ? 'snapshot-btn' : event.key.toLowerCase() === 'r' ? 'record-btn' : null;
  if (id && !$(id).disabled) { event.preventDefault(); $(id).click(); }
});
new ResizeObserver(paintChart).observe($('trace-canvas'));
new ResizeObserver(paintMarkers).observe($('viewport'));
setInterval(() => {
  const now = performance.now();
  if (state.connected && frameTimes.length > 1 && now - lastFrameArrival < 2000) {
    const elapsed = frameTimes[frameTimes.length - 1] - frameTimes[0];
    $('frame-rate').textContent = `${Math.round((frameTimes.length - 1) * 1000 / Math.max(1, elapsed))} fps`;
  } else if (state.connected && latestFrame) $('frame-rate').textContent = 'Waiting for frames';
  if (recordStarted) {
    const seconds = Math.floor((Date.now() - recordStarted) / 1000);
    $('record-time').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
}, 500);

async function initialize() {
  paintChart();
  if (!api) { $('device-select').replaceChildren(new Option('Desktop connection unavailable', '')); setStatus('Launch Caloraview with the desktop launcher to access the camera.', true); return; }
  api.onFrame(onFrame);
  api.onStatus(updateStatus);
  const result = await call('state', undefined, { quiet: true });
  if (result) updateStatus(result.status || result);
  await scanDevices();
}
initialize();
