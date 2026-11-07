'use strict';
// Isolated UI/persistence check. Does not connect to or change the camera.
const { _electron: electron } = require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {DEFAULT_MEASUREMENT_ENVIRONMENT}=require('../src/core/preferences.cjs');
(async()=>{
  const root=path.resolve(__dirname,'..'),base=path.join(root,'test-output/reflection-ui');
  fs.mkdirSync(base,{recursive:true});const output=fs.mkdtempSync(path.join(base,'check-'));
  const preferences=path.join(output,'preferences.json');
  fs.writeFileSync(preferences,JSON.stringify({temperatureUnit:'F',measurementEnvironment:{...DEFAULT_MEASUREMENT_ENVIRONMENT,reflectedC:20}}));
  const desktop=await electron.launch({args:[root,'--user-data-dir='+path.join(output,'user-data')],env:{...process.env,CALORAVIEW_PREFERENCES_PATH:preferences,CALORAVIEW_OUTPUT:output}});
  const errors=[];
  try{
    const page=await desktop.firstWindow();page.on('pageerror',e=>errors.push(e.message));
    await page.waitForFunction(()=>window.caloraview&&document.querySelector('#temperature-unit-select').value==='F');
    const open=()=>page.click('#measurement-parameters-btn');
    const field=page.locator('#env-reflected'),checkbox=page.locator('#env-reflected-manual');
    await open();assert.equal(await checkbox.isChecked(),false);assert.equal(await field.isDisabled(),true);assert.equal(await field.inputValue(),'');
    // Inject a camera status event without acquiring hardware or inventing a
    // measured scene. This tests only automatic estimate presentation.
    await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('caloraview:status',{connected:true,automaticReflectedC:31.8399658203125}));
    await page.waitForFunction(()=>document.querySelector('#env-reflected').value==='89.3');
    await page.screenshot({path:path.join(output,'automatic.png'),fullPage:true});
    await checkbox.check();assert.equal(await field.isEnabled(),true);assert.equal(await field.inputValue(),'68');
    await field.fill('75');await checkbox.uncheck();assert.equal(await field.inputValue(),'89.3');
    await checkbox.check();assert.equal(await field.inputValue(),'75');
    await page.click('#measurement-parameters-apply');await page.waitForFunction(()=>!document.querySelector('dialog').open);
    let saved=JSON.parse(fs.readFileSync(preferences));assert.equal(saved.measurementEnvironment.reflectedManualOverride,true);assert.equal(saved.measurementEnvironment.reflectedC,(75-32)*5/9);
    await open();assert.equal(await checkbox.isChecked(),true);await page.screenshot({path:path.join(output,'manual.png'),fullPage:true});
    await checkbox.uncheck();await page.click('#measurement-parameters-apply');await page.waitForFunction(()=>!document.querySelector('dialog').open);
    saved=JSON.parse(fs.readFileSync(preferences));assert.equal(saved.measurementEnvironment.reflectedManualOverride,false);assert.equal(saved.measurementEnvironment.reflectedC,(75-32)*5/9);
    await page.selectOption('#temperature-unit-select','C');
    await page.waitForFunction(()=>!document.querySelector('#measurement-parameters-btn').disabled);
    await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('caloraview:status',{connected:true,automaticReflectedC:31.8399658203125}));
    await open();assert.equal(await field.inputValue(),'31.8');assert.equal(await field.isDisabled(),true);
    await checkbox.check();assert.equal(await field.inputValue(),'23.888889');
    await page.click('#measurement-parameters-cancel');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({status:'passed',output,checks:'automatic estimate, pending state, override toggle, persistence, cancel, C/F units',rendererErrors:errors}));
  }finally{await desktop.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
