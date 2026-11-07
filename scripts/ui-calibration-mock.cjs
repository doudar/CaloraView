// Offline renderer checks: hidden Electron window, synthetic IPC, no camera backend.
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {transformPreview}=require('../src/core/display-transform.cjs');
(async()=>{
  const fixture=path.resolve('test-output/ui-calibration-mock');fs.mkdirSync(fixture,{recursive:true});
  const device='mock://vid_38be&pid_0184/sk02';
  fs.writeFileSync(path.join(fixture,'preload.cjs'),`
    let onStatus,onFrame;window.mockCalls=[];
    window.mockPixels=(w,h)=>{const a=new Uint8Array(w*h*4);for(let i=0;i<a.length;i+=4){a[i]=18;a[i+1]=25;a[i+2]=34;a[i+3]=255;}return a;};
    window.mockStatus=value=>onStatus(value);
    window.mockFrame=(overrides={})=>onFrame({width:256,height:192,rgba:window.mockPixels(256,192),stats:{center:5000,high:5100,low:4900,highX:30,highY:40,lowX:200,lowY:100},temperatures:null,sequence:1,mode:'raw',flatField:true,...overrides});
    window.caloraview={onFrame(cb){onFrame=cb},onStatus(cb){onStatus=cb},async invoke(action,payload){
      window.mockCalls.push({action,payload});
      if(action==='settings'){onStatus({...(payload.resolution?{previewResolution:payload.resolution}:{}),...(payload.rotation!==undefined?{rotation:payload.rotation}:{}),...(payload.temperatureUnit?{temperatureUnit:payload.temperatureUnit}:{}),...(payload.logFrequencyHz?{logFrequencyHz:payload.logFrequencyHz}:{}),...(payload.measurementEnvironment?{measurementEnvironment:payload.measurementEnvironment}:{})});}
      if(action==='devices')return {ok:true,devices:[{id:${JSON.stringify(device)},name:'SK02'},{id:'other',name:'Other camera'}]};
      if(action==='state')return {ok:true,connected:false,connecting:false,initializationBusy:false,calibrationSupported:true,logFrequencyHz:2};
      return {ok:true};
    }};
  `);
  fs.writeFileSync(path.join(fixture,'main.cjs'),`
    const {app,BrowserWindow}=require('electron');
    app.whenReady().then(()=>new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(path.join(fixture,'preload.cjs'))},contextIsolation:false,nodeIntegration:false}}).loadFile(${JSON.stringify(path.resolve('src/renderer/index.html'))}));
  `);
  const desktop=await electron.launch({args:[path.join(fixture,'main.cjs')]});
  try{
    const page=await desktop.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.waitForFunction(()=>!document.querySelector('#connect-btn').disabled);
    assert.equal(await page.title(),'Caloraview • Thermal workspace');
    assert(await page.locator('.brand-icon').evaluate(e=>e.complete&&e.naturalWidth>0));
    assert.equal(await page.locator('#download-calibration-btn').count(),0);
    assert.equal(await page.locator('#display-rendering').count(),0);
    assert.equal(await page.locator('.factory-panel').count(),0);assert.equal(await page.locator('.session-bar').count(),0);
    assert.equal(await page.locator('#log-frequency-select').inputValue(),'2');
    for(const rate of ['0.2','0.5','1','2']){await page.locator('#log-frequency-select').selectOption(rate);assert.equal(await page.locator('#log-frequency-select').inputValue(),rate);}
    assert(await page.evaluate(()=>window.mockCalls.some(c=>c.action==='settings'&&c.payload.logFrequencyHz===.2)));
    for(const id of ['flat-field-btn','clear-flat-field-btn','apply-uniform-target-btn'])assert.equal(await page.locator('#'+id).count(),0);
    assert.equal(await page.locator('#shutter-btn').innerText(),'Auto calibrate');
    // Parameters are editable before connecting, with persisted physical units.
    await page.locator('#measurement-parameters-btn').click();
    assert(await page.locator('#measurement-parameters-dialog').isVisible());
    assert.equal(await page.locator('#env-emissivity').inputValue(),'0.91');
    assert.equal(await page.locator('#env-distance').inputValue(),'0.9144');
    assert.equal(await page.locator('#env-ambient').inputValue(),'20');
    const beforeCancel=await page.evaluate(()=>window.mockCalls.length);
    await page.locator('#env-emissivity').fill('0.95');
    await page.locator('#measurement-parameters-cancel').click();
    assert.equal(await page.evaluate(()=>window.mockCalls.length),beforeCancel);
    await page.locator('#temperature-unit-select').selectOption('F');
    await page.locator('#measurement-parameters-btn').click();
    assert.equal(await page.locator('#env-ambient').inputValue(),'68');
    assert.equal(await page.locator('#env-distance-unit').inputValue(),'ft');
    assert.equal(await page.locator('#env-distance').inputValue(),'3');
    assert.equal(await page.locator('#env-ambient').getAttribute('max'),'212');
    assert.equal(await page.locator('#env-emissivity').inputValue(),'0.91');
    await page.locator('#env-emissivity').fill('0');
    const beforeInvalid=await page.evaluate(()=>window.mockCalls.length);
    await page.locator('#measurement-parameters-apply').click();
    assert(await page.locator('#measurement-parameters-dialog').isVisible());
    assert.equal(await page.evaluate(()=>window.mockCalls.length),beforeInvalid);
    await page.locator('#env-emissivity').fill('0.91');
    await page.locator('#env-distance').fill('3');
    await page.locator('#env-distance-unit').selectOption('m');
    assert.equal(await page.locator('#env-distance').inputValue(),'0.9144');
    await page.locator('#env-distance-unit').selectOption('ft');
    assert.equal(await page.locator('#env-distance').inputValue(),'3');
    for(const [id,value] of Object.entries({'ice-water':.95,pcb:.91,concrete:.95,ceramics:.92,paint:.93,wood:.85,asphalt:.96,brick:.95,sand:.90,soil:.92,cotton:.98,cardboard:.90,'white-paper':.90,water:.96})){
      await page.locator('#env-material').selectOption(id);assert.equal(Number(await page.locator('#env-emissivity').inputValue()),value);
    }
    await page.locator('#env-emissivity').fill('0.93');assert.equal(await page.locator('#env-material').inputValue(),'custom');
    await page.locator('#env-material').selectOption('pcb');
    await page.locator('#env-ambient').fill('77');
    await page.locator('#env-reflected').fill('59');
    await page.locator('#env-humidity').fill('45');
    await page.locator('#measurement-parameters-apply').click();
    await page.waitForFunction(()=>!document.querySelector('#measurement-parameters-dialog').open);
    const sentEnvironment=await page.evaluate(()=>window.mockCalls.filter(c=>c.payload?.measurementEnvironment).at(-1).payload.measurementEnvironment);
    assert.deepEqual(sentEnvironment,{emissivityPreset:'pcb',emissivity:.91,distanceMeters:.9144,ambientC:25,reflectedC:15,humidityPercent:45});
    await page.locator('#temperature-unit-select').selectOption('C');
    for(const [width,height] of [[1280,800],[960,700],[900,650]]){
      await page.setViewportSize({width,height});await page.locator('#measurement-parameters-btn').click();
      assert.equal(await page.locator('#env-ambient').inputValue(),'25');
      assert.equal(await page.locator('#env-material').inputValue(),'pcb');
      assert.equal(await page.locator('#env-distance-unit').inputValue(),'m');
      assert.equal(await page.locator('#env-distance').inputValue(),'0.9144');
      const box=await page.locator('#measurement-parameters-dialog').boundingBox();
      assert(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height,'Parameter dialog outsideviewport');
      await page.screenshot({path:path.join(fixture,'parameters-'+width+'x'+height+'.png')});
      await page.keyboard.press('Escape');assert(await page.locator('#measurement-parameters-dialog').isHidden());
    }
    for(const lock of ['recording','logging','initializationBusy','connecting','shutterBusy','busy']){
      await page.locator('#measurement-parameters-btn').click();
      await page.evaluate(key=>window.mockStatus({[key]:true}),lock);
      assert(await page.locator('#measurement-parameters-btn').isDisabled());
      assert(await page.locator('#measurement-parameters-apply').isDisabled());
      await page.locator('#measurement-parameters-cancel').click();
      await page.evaluate(key=>window.mockStatus({[key]:false}),lock);
    }
    for(const [width,height] of [[1280,800],[960,700],[900,650]]){
      await page.setViewportSize({width,height});
      await page.evaluate(()=>window.mockStatus({connected:false,connecting:false,initializationBusy:false,calibrationBusy:false}));
      const geometry=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}));
      assert(geometry.scrollWidth<=width&&geometry.scrollHeight<=height,`Layout overflow ${JSON.stringify(geometry)}`);
      for(const selector of ['#connect-btn','#snapshot-btn','#record-btn','#log-btn','#shutter-btn','#resolution-select','#rotate-left-btn','#rotate-right-btn','.log-capture-panel','#log-frequency-select']){
        const box=await page.locator(selector).boundingBox();assert(box&&box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height,`${selector} outside ${width}x${height}`);
      }
      const brand=await page.locator('.brand').boundingBox(),right=await page.locator('.header-right').boundingBox();assert(brand.x+brand.width<right.x);
      await page.screenshot({path:path.join(fixture,`caloraview-${width}x${height}.png`)});
      await page.evaluate(()=>window.mockStatus({connecting:true,initializationBusy:true,initializationProgress:42,initializationMessage:'Downloading camera factory files…',calibrationBusy:true}));
      assert(await page.locator('#initialization-overlay').isVisible());
      assert.equal(await page.locator('#initialization-progress').getAttribute('value'),'42');
      assert.equal(await page.locator('#initialization-percent').innerText(),'42%');
      assert(await page.locator('#connect-btn').isDisabled());
      const view=await page.locator('#viewport').boundingBox(),card=await page.locator('.initialization-card').boundingBox();
      assert(Math.abs(card.x+card.width/2-view.x-view.width/2)<2&&Math.abs(card.y+card.height/2-view.y-view.height/2)<2,'Setup overlay not centered');
      await page.screenshot({path:path.join(fixture,`initialization-${width}x${height}.png`)});
    }
    await page.evaluate(()=>window.mockStatus({initializationProgress:null}));
    assert.equal(await page.locator('#initialization-progress').getAttribute('value'),null);
    await page.evaluate(()=>window.mockStatus({connected:true,connecting:true,calibrationBusy:false,initializationBusy:true,initializationProgress:88,initializationMessage:'Capturing automatic shutter reference…',calibrationDownloaded:true,calibrationDevice:'mock://vid_38be&pid_0184/sk02',calibrationSource:'cache',shutterSupported:true,shutterBusy:true}));
    await page.evaluate(()=>window.mockFrame());
    await page.waitForFunction(()=>document.querySelector('#raw-center').textContent !== '—');
    assert(await page.locator('#initialization-overlay').isVisible());
    assert(await page.locator('#record-btn').isDisabled());

    await page.evaluate(()=>window.mockStatus({connecting:false,initializationBusy:false,initializationProgress:100,shutterBusy:false}));
    assert(await page.locator('#initialization-overlay').isHidden());
    assert(!(await page.locator('#record-btn').isDisabled()));
    assert.match(await page.locator('#temp-center').innerText(),/—/);
    await page.evaluate(()=>{
      window.markerRects=[];const ctx=document.querySelector('#overlay-canvas').getContext('2d');const original=ctx.strokeRect.bind(ctx);ctx.strokeRect=(...v)=>{const t=ctx.getTransform();window.markerRects.push({center:[t.e,t.f],scale:t.a,rect:v});original(...v)};
      window.mockFrame({factoryCorrected:true,flatField:false,temperatures:{center:25.125,high:48.5,low:17.25,highX:42,highY:57,lowX:188,lowY:143},calibration:{status:'factory-calibrated',serial:'synthetic',algorithm:'synthetic test',environment:{ambientC:20,reflectedC:20,humidityPercent:60,distanceMeters:1,emissivity:.97},absoluteAccuracyValidated:false}});
    });
    await page.waitForFunction(()=>document.querySelector('#temp-center').textContent.startsWith('25.1'));
    assert.equal(await page.locator('#temp-high').innerText(),'48.5°C');
    assert.equal(await page.locator('#overlay-canvas').getAttribute('data-marker-source'),'temperature');
    assert(await page.evaluate(()=>window.markerRects.some(v=>v.center[0]===127.5&&v.center[1]===172.5)),'High marker does not use temperature coordinates');
    assert(!(await page.locator('#shutter-btn').isDisabled()));
    assert.match(await page.locator('#calibration-notice').getAttribute('title'),/reflected 20°C/);
    assert.match(await page.locator('#calibration-notice-detail').innerText(),/ε 0.97/);
    assert.match(await page.locator('#log-capture-description').innerText(),/configured environment values/);
    assert(await page.locator('#calibration-notice-title').isHidden());
    assert.equal(await page.locator('#raw-center').innerText(),'5,000');
    await page.locator('#resolution-select').selectOption('enhanced');
    await page.waitForFunction(()=>window.mockCalls.some(c=>c.action==='settings'&&c.payload.resolution==='enhanced'));
    // Enhancement setup is independent of camera calibration and measurements.
    await page.evaluate(()=>window.mockStatus({enhancementState:'loading',enhancementMessage:'Preparing the local HD model…'}));
    assert.equal(await page.locator('#enhancement-status').innerText(),'HD loading…');
    assert.equal(await page.locator('#temp-center').innerText(),'25.1°C');
    assert(await page.locator('#initialization-overlay').isHidden());
    for(const id of ['snapshot-btn','record-btn','log-btn','shutter-btn','resolution-select'])assert(!(await page.locator('#'+id).isDisabled()),id+' blocked by HD loading');
    await page.evaluate(()=>{window.hdMock={width:512,height:384,rgba:window.mockPixels(512,384),factoryCorrected:true,temperatures:{center:25.125,high:48.5,low:17.25,highX:42,highY:57,lowX:188,lowY:143},calibration:{status:'factory-calibrated',environment:{ambientC:20,reflectedC:20,humidityPercent:60,distanceMeters:1,emissivity:.97}}};});
    for(const [method,model] of [['realesrgan-x4v3-display','Real-ESRGAN x4v3'],['fsrcnn-x2-display','FSRCNN x2']]){
      await page.evaluate(({method,model})=>{window.mockStatus({enhancementState:'ready'});window.mockFrame({...window.hdMock,displayTransform:{resolution:'enhanced',method,model,provider:'cpu'}});},{method,model});
      await page.waitForFunction(m=>document.querySelector('#resolution-select').dataset.method===m,method);
      assert.match(await page.locator('#resolution-select').getAttribute('title'),/AI display enhancement/);
      assert((await page.locator('#resolution-select').getAttribute('title')).includes(model+' · cpu'));
      assert(await page.locator('#enhancement-status').isHidden());
      assert.equal(await page.locator('#temp-center').innerText(),'25.1°C');
    }
    for(const [width,height] of [[1280,800],[960,700],[900,650]]){
      await page.setViewportSize({width,height});
      await page.evaluate(()=>window.mockStatus({enhancementState:'loading'}));
      const live=await page.locator('#stream-badge').boundingBox(),busy=await page.locator('#enhancement-status').boundingBox();
      assert(live.x+live.width<=busy.x,'HD status overlaps live badge');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight),'AI state causes layout overflow');
      await page.screenshot({path:path.join(fixture,'hd-ai-loading-'+width+'x'+height+'.png')});
    }
    await page.evaluate(()=>{window.mockStatus({enhancementState:'fallback',enhancementMessage:'Local AI model unavailable; interpolation active.'});window.mockFrame({...window.hdMock,displayTransform:{resolution:'enhanced',method:'bounded-bicubic-display',fallbackReason:'Synthetic model failure'}});});
    await page.waitForFunction(()=>document.querySelector('#resolution-select').dataset.method==='bounded-bicubic-display');
    assert.equal(await page.locator('#enhancement-status').innerText(),'HD fallback');
    assert.match(await page.locator('#resolution-select').getAttribute('title'),/Synthetic model failure/);
    assert.equal(await page.locator('#temp-center').innerText(),'25.1°C');
    assert(!(await page.locator('#record-btn').isDisabled()));
    // Requested mode must never relabel an actual native frame as AI.
    await page.evaluate(()=>window.mockFrame({...window.hdMock,width:256,height:192,rgba:window.mockPixels(256,192),displayTransform:{resolution:'native',method:'native'}}));
    await page.waitForFunction(()=>document.querySelector('#resolution-select').dataset.method==='native');
    assert.equal(await page.locator('#thermal-canvas').evaluate(e=>getComputedStyle(e).imageRendering),'pixelated');
    await page.locator('#resolution-select').selectOption('native');
    assert(await page.locator('#enhancement-status').isHidden());
    await page.locator('#resolution-select').selectOption('enhanced');
    await page.evaluate(()=>window.mockStatus({enhancementState:'ready',enhancementMessage:''}));
    await page.locator('#rotate-right-btn').click();
    await page.waitForFunction(()=>window.mockCalls.some(c=>c.action==='settings'&&c.payload.rotation===90));
    await page.evaluate(()=>{window.markerRects=[];window.mockFrame({width:384,height:512,rgba:window.mockPixels(384,512),factoryCorrected:true,temperatures:{center:25.125,high:48.5,low:17.25,highX:42,highY:57,lowX:188,lowY:143},calibration:{status:'factory-calibrated',environment:{ambientC:20,reflectedC:20,humidityPercent:60,distanceMeters:1,emissivity:.97},absoluteAccuracyValidated:false},displayMarkers:{source:'temperature',center:{x:190.5,y:256.5},high:{x:268.5,y:84.5},low:{x:96.5,y:376.5}}});});
    await page.waitForFunction(()=>document.querySelector('#thermal-canvas').width===384);
    assert(await page.evaluate(()=>window.markerRects.some(v=>v.center[0]===403.5&&v.center[1]===127.5)),'Rotated HD high marker not mapped');
    assert(await page.evaluate(()=>{const a=document.querySelector('#thermal-canvas'),b=document.querySelector('#overlay-canvas');return a.width/a.height===b.width/b.height}),'Rotated image/marker aspect mismatch');
    await page.locator('#rotate-left-btn').click();
    await page.waitForFunction(()=>window.mockCalls.some(c=>c.action==='settings'&&c.payload.rotation===0));
    await page.locator('#shutter-btn').click();
    assert(await page.evaluate(()=>window.mockCalls.some(c=>c.action==='shutter')));
    for(const [width,height] of [[1280,800],[960,700],[900,650]]){
      await page.setViewportSize({width,height});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight),'Calibrated layout overflow');
      await page.evaluate(()=>window.markerRects=[]);
      await page.locator('#markers-toggle').uncheck();await page.locator('#markers-toggle').check();
      assert(await page.evaluate(()=>{const c=document.querySelector('#overlay-canvas'),scale=Math.min(c.clientWidth/c.width,c.clientHeight/c.height);return window.markerRects.every(v=>Math.abs(v.scale*scale-1)<.000001)}),'Reticle does not retain CSS size');
      assert(await page.locator('#calibration-notice-detail').evaluate(e=>e.getBoundingClientRect().bottom<=e.closest('.measurements').getBoundingClientRect().bottom),'Environment note clipped vertically');
      await page.screenshot({path:path.join(fixture,'celsius-'+width+'x'+height+'.png')});
      await page.locator('#temperature-unit-select').selectOption('F');
      await page.waitForFunction(()=>document.querySelector('#temp-center').textContent==='77.2°F');
      assert.equal(await page.locator('#temp-high').innerText(),'119.3°F');
      assert.match(await page.locator('#calibration-notice').getAttribute('title'),/reflected 68°F/);
      assert.match(await page.locator('#calibration-notice-detail').innerText(),/air 68°F/);
      assert.equal(await page.locator('#raw-center').innerText(),'5,000');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight),'Fahrenheit layout overflow');
      assert(await page.locator('#temp-high').evaluate(e=>e.scrollWidth<=e.clientWidth),'Fahrenheit temperature card overflow');
      await page.screenshot({path:path.join(fixture,'fahrenheit-'+width+'x'+height+'.png')});
      await page.locator('#temperature-unit-select').selectOption('C');
      await page.waitForFunction(()=>document.querySelector('#temp-center').textContent==='25.1°C');
    }
    await page.evaluate(()=>window.mockStatus({shutterBusy:true}));
    assert.match(await page.locator('#temp-center').innerText(),/—/);assert.match(await page.locator('#calibration-notice-title').innerText(),/shutter/);
    assert.equal(await page.locator('#overlay-canvas').getAttribute('data-marker-source'),'reference');
    await page.evaluate(()=>window.mockStatus({shutterBusy:false}));assert.match(await page.locator('#temp-center').innerText(),/25.1/);
    await page.evaluate(()=>window.mockFrame({factoryCorrected:true,temperatures:{center:999,high:999,low:999},calibration:{status:'out-of-range',reason:'Synthetic detector value is outside the supported calibration range.'}}));
    await page.waitForFunction(()=>document.querySelector('#calibration-notice-title').textContent==='Temperature out of range');
    assert.match(await page.locator('#temp-center').innerText(),/—/);assert.equal(await page.locator('#overlay-canvas').getAttribute('data-marker-source'),'detector');
    await page.evaluate(()=>window.mockFrame({factoryCorrected:false,calibration:{status:'unavailable',reason:'Waiting for a valid shutter reference.'}}));
    await page.waitForFunction(()=>document.querySelector('#calibration-notice-title').textContent==='Temperature unavailable');
    assert.match(await page.locator('#temp-high').innerText(),/—/);assert.equal(await page.locator('#flat-field-btn').count(),0);
    await page.evaluate(()=>window.mockFrame({factoryCorrected:true,temperatures:{center:-40,high:0,low:-55,highX:42,highY:57,lowX:188,lowY:143},calibration:{status:'factory-calibrated',environment:{ambientC:-10,reflectedC:-20,humidityPercent:60,distanceMeters:1,emissivity:.97},absoluteAccuracyValidated:false}}));
    await page.waitForFunction(()=>document.querySelector('#temp-low').textContent==='-55.0°C');
    await page.evaluate(()=>window.mockStatus({temperatureUnit:'F',recording:true}));
    assert.equal(await page.locator('#temperature-unit-select').inputValue(),'F');
    assert.equal(await page.locator('#temp-center').innerText(),'-40.0°F');
    assert.equal(await page.locator('#temp-low').innerText(),'-67.0°F');
    assert.equal(await page.locator('#temp-high').innerText(),'32.0°F');
    assert.match(await page.locator('#calibration-notice').getAttribute('title'),/reflected -4°F/);
    assert(!(await page.locator('#temperature-unit-select').isDisabled()));
    await page.locator('#temperature-unit-select').selectOption('C');
    await page.waitForFunction(()=>document.querySelector('#temp-low').textContent==='-55.0°C');
    assert(await page.locator('#shutter-btn').isDisabled());assert(await page.locator('#log-frequency-select').isDisabled());
    await page.evaluate(()=>window.mockStatus({recording:false,calibrationDownloaded:false,calibrationError:'Synthetic cache verification failed.'}));

    await page.locator('#log-frequency-select').selectOption('0.2');
    await page.evaluate(()=>window.mockStatus({logging:true}));assert(await page.locator('#log-frequency-select').isDisabled());
    assert.match(await page.locator('#log-capture-description').innerText(),/every 5 s/);assert(await page.locator('#logging-indicator').isVisible());
    await page.evaluate(()=>window.mockStatus({logging:false}));
    // Exercise production display transforms through the renderer with a known
    // sharp-edge scene, then compare actual compositor pixels in the same crop.
    await page.setViewportSize({width:1280,height:800});await page.locator('#markers-toggle').uncheck();
    const rgba=new Uint8Array(256*192*4);for(let y=0;y<192;y++)for(let x=0;x<256;x++){const i=(y*256+x)*4,v=((x>>3)^(y>>3))&1?255:0;rgba[i]=rgba[i+1]=rgba[i+2]=v;rgba[i+3]=255;}
    const base={width:256,height:192,rgba,stats:{center:5000,high:5100,low:4900,highX:30,highY:40,lowX:200,lowY:100},temperatures:null,sequence:700,mode:'raw'};
    const screenshots=[];
    for(const resolution of ['native','enhanced']){
      await page.locator('#resolution-select').selectOption(resolution);
      const frame=transformPreview(base,{resolution,rotation:0});
      await page.evaluate(f=>window.mockFrame({...f,rgba:Uint8Array.from(f.rgba)}),{...frame,rgba:Array.from(frame.rgba)});
      await page.waitForFunction(r=>document.querySelector('#thermal-canvas').dataset.resolution===r&&document.querySelector('#resolution-select').dataset.method===(r==='native'?'native':'bounded-bicubic-display'),resolution);
      assert.equal(await page.locator('#thermal-canvas').evaluate(e=>getComputedStyle(e).imageRendering),resolution==='native'?'pixelated':'auto');
      assert.equal(await page.locator('#resolution-select').getAttribute('data-method'),resolution==='native'?'native':'bounded-bicubic-display');
      const box=await page.locator('#viewport').boundingBox(),clip={x:Math.floor(box.x+box.width/2-64),y:Math.floor(box.y+box.height/2-64),width:128,height:128};
      const png=await page.screenshot({clip,path:path.join(fixture,'rendering-'+resolution+'.png')});
      screenshots.push(await desktop.evaluate(({nativeImage},data)=>{const im=nativeImage.createFromBuffer(Buffer.from(data,'base64'));return Array.from(im.toBitmap());},png.toString('base64')));
    }
    assert.equal(screenshots[0].length,screenshots[1].length);let different=0,totalDifference=0;const tones=[new Set(),new Set()];
    for(let i=0;i<screenshots[0].length;i+=4){for(let j=0;j<2;j++)tones[j].add(screenshots[j][i]);const d=Math.abs(screenshots[0][i]-screenshots[1][i]);if(d)different++;totalDifference+=d;}
    const metrics={differentPixels:different,totalPixels:screenshots[0].length/4,meanDifference:totalDifference/(screenshots[0].length/4),nativeTones:tones[0].size,enhancedTones:tones[1].size};
    assert(metrics.meanDifference>1&&metrics.differentPixels>metrics.totalPixels*.05,JSON.stringify(metrics));
    assert(metrics.enhancedTones>metrics.nativeTones,JSON.stringify(metrics));
    fs.writeFileSync(path.join(fixture,'rendering-comparison.json'),JSON.stringify(metrics,null,2));
    console.log('Native/HD compositor comparison:',JSON.stringify(metrics));
    await page.evaluate(()=>window.mockStatus({connected:false,connecting:false,initializationBusy:false,error:'Synthetic connection failure'}));
    assert(await page.locator('#initialization-overlay').isHidden());
    assert(!(await page.locator('#connect-btn').isDisabled()));
    assert.deepEqual(errors,[]);
    console.log('Offline renderer checks passed at1280x800,960x700,900x650: all controls fit; automatic-only setup, progress, cache/error states, calibrated/invalid Celsius transitions, native/HD/rotation actions, transformed thermal markers, canceled target controls absent, CSS reticle sizes, Celsius/Fahrenheit, log frequency locks, marked removals, native/HD rendering, in-image mode text absent, selector method tooltips, nonblocking loading/fallback, environment dialog presets, feet/meters conversion, validation, persistence and locks verified.');
  }finally{await desktop.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
