'use strict';
// Real source or packaged app/settings IPC, isolated preferences, no capture actions.
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
  const folder=fs.mkdtempSync(path.resolve('test-output/parameters-integration-'));
  const preferenceFile=path.join(folder,'preferences.json');
  const env={...process.env,CALORAVIEW_PREFERENCES_PATH:preferenceFile,CALORAVIEW_OUTPUT:folder};
  let desktop,page;const errors=[];
  async function launch(){const packaged=process.env.CALORAVIEW_TEST_PACKAGED;desktop=await electron.launch(packaged?{executablePath:path.resolve(packaged),args:[],env}:{args:[path.resolve('.')],env});page=await desktop.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>!!window.caloraview&&!document.querySelector('#device-select').textContent.includes('Scanning')&&!document.querySelector('#measurement-parameters-btn').disabled);}
  async function state(){return page.evaluate(()=>window.caloraview.invoke('state'));}
  try{
    await launch();
    const precise={emissivityPreset:'custom',emissivity:.91,distanceMeters:.9144,ambientC:21.123456789,reflectedC:19.234567891,humidityPercent:47};
    const setup=await page.evaluate(async value=>window.caloraview.invoke('settings',{measurementEnvironment:value,temperatureUnit:'F'}),precise);
    assert.equal(setup.ok,true,setup.error);
    await page.locator('#measurement-parameters-btn').click();
    assert.equal(await page.locator('#env-distance-unit').inputValue(),'ft');
    assert.equal(await page.locator('#env-distance').inputValue(),'3');
    await page.locator('#env-material').selectOption('paint');
    await page.locator('#env-distance').fill('10');
    await page.locator('#measurement-parameters-apply').click();
    await page.waitForFunction(()=>!document.querySelector('#measurement-parameters-dialog').open);
    const expected={...precise,emissivityPreset:'paint',emissivity:.93,distanceMeters:3.048};
    assert.deepEqual((await state()).measurementEnvironment,expected);
    for(const unit of ['C','F']){
      await page.locator('#temperature-unit-select').selectOption(unit);
      await page.waitForFunction(async expected=>(await window.caloraview.invoke('state')).temperatureUnit===expected,unit);
      assert.deepEqual((await state()).measurementEnvironment,expected);
    }
    const before=fs.readFileSync(preferenceFile,'utf8');
    const invalid=await page.evaluate(value=>window.caloraview.invoke('settings',{measurementEnvironment:{...value,emissivity:2}}),expected);
    assert.equal(invalid.ok,false);assert.deepEqual((await state()).measurementEnvironment,expected);
    assert.equal(fs.readFileSync(preferenceFile,'utf8'),before);
    assert.equal((await state()).connected,false);
    await desktop.close();desktop=null;
    await launch();
    const restored=await state();assert.equal(restored.temperatureUnit,'F');assert.deepEqual(restored.measurementEnvironment,expected);assert.equal(restored.connected,false);
    await page.setViewportSize({width:960,height:700});
    await page.locator('#measurement-parameters-btn').click();
    assert.equal(await page.locator('#env-material').inputValue(),'paint');
    assert.equal(await page.locator('#env-distance-unit').inputValue(),'ft');assert.equal(await page.locator('#env-distance').inputValue(),'10');
    await page.screenshot({path:path.join(folder,'parameters-persisted.png')});
    await page.locator('#measurement-parameters-apply').click();
    await page.waitForFunction(()=>!document.querySelector('#measurement-parameters-dialog').open);
    assert.deepEqual((await state()).measurementEnvironment,expected,'Unchanged dialog inputs must preserve exact Celsius/meters');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({status:'passed',folder,preferences:restored.measurementEnvironment,temperatureUnit:restored.temperatureUnit,rendererErrors:errors}));
  }finally{if(desktop)await desktop.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
