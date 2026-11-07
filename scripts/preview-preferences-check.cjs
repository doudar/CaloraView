'use strict';
// Isolated desktop restart/persistence check; never opens the camera.
const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
  const root=path.resolve(__dirname,'..'),base=path.join(root,'test-output/preview-preferences');
  fs.mkdirSync(base,{recursive:true});const output=fs.mkdtempSync(path.join(base,'check-'));
  const preferences=path.join(output,'preferences.json');
  async function check(expected,change){
    const desktop=await electron.launch({args:[root,'--user-data-dir='+path.join(output,'user-data')],env:{...process.env,CALORAVIEW_PREFERENCES_PATH:preferences,CALORAVIEW_OUTPUT:output}});
    try{
      const page=await desktop.firstWindow();
      await page.waitForFunction(expected=>document.querySelector('#resolution-select')?.value===expected,expected);
      const invoke=(action,payload)=>page.evaluate(({action,payload})=>window.caloraview.invoke(action,payload),{action,payload});
      const initial=await invoke('state');assert.equal(initial.previewResolution,expected);
      if(change){
        await page.selectOption('#resolution-select',change);
        await page.waitForFunction(()=>!document.querySelector('#measurement-parameters-btn').disabled);
        assert.equal((await invoke('state')).previewResolution,change);
        assert.equal((await invoke('settings',{temperatureUnit:'F'})).ok,true);
        assert.equal((await invoke('settings',{measurementEnvironment:initial.measurementEnvironment})).ok,true);
        const saved=JSON.parse(fs.readFileSync(preferences));
        assert.equal(saved.previewResolution,change);assert.equal(saved.temperatureUnit,'F');
        assert.deepEqual(saved.measurementEnvironment,initial.measurementEnvironment);
        const bytes=fs.readFileSync(preferences);
        assert.equal((await invoke('settings',{resolution:'unsupported'})).ok,false);
        assert.deepEqual(fs.readFileSync(preferences),bytes);
      }
      return initial;
    }finally{await desktop.close();}
  }
  await check('enhanced','native');
  assert.equal((await check('native','enhanced')).temperatureUnit,'F');
  assert.equal((await check('enhanced')).temperatureUnit,'F');
  console.log(JSON.stringify({status:'passed',output,checks:'HD default, native restart, HD restart, unrelated settings preserve selection, invalid mode does not overwrite preferences'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
