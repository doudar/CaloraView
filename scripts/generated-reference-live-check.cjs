'use strict';
// Hardware smoke: run only when the camera is available and the parent coordinates it.
// Real preferences are copied, never written; no DDAC/register upload is performed here.
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {loadPreferences}=require('../src/core/preferences.cjs');
const ALGORITHM='sk02-float-online-port-v3-generated-reference';
const root=path.resolve(__dirname,'..');
function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
function csv(file){const lines=fs.readFileSync(file,'utf8').trim().split(/\r?\n/),names=lines.shift().split(',');return lines.map(line=>Object.fromEntries(line.split(',').map((v,i)=>[names[i],v])));}
(async()=>{
 const base=path.join(root,'test-output/generated-reference');fs.mkdirSync(base,{recursive:true});const output=fs.mkdtempSync(path.join(base,'check-'));
 const sourcePreferences=path.resolve(process.env.CALORAVIEW_PREFERENCES_PATH||path.join(process.env.APPDATA||'', 'caloraview-desktop/preferences.json'));
 if(!fs.existsSync(sourcePreferences))throw Error('Existing user preference file required; set CALORAVIEW_PREFERENCES_PATH explicitly if needed');
 const originalBytes=fs.readFileSync(sourcePreferences),expected=loadPreferences(sourcePreferences),preferenceFile=path.join(output,'preferences.json');fs.writeFileSync(preferenceFile,originalBytes);
 const env={...process.env,CALORAVIEW_PREFERENCES_PATH:preferenceFile,CALORAVIEW_OUTPUT:output};
 const packaged=process.env.CALORAVIEW_TEST_PACKAGED;
 const executable=packaged?(packaged==='1'?path.join(root,'dist/win-unpacked/Caloraview Desktop.exe'):path.resolve(packaged)):null;
 let desktop,page,logging=false;const errors=[];const report={status:'started',output,sourcePreferences,preferences:expected,packaged:!!packaged,algorithm:ALGORITHM};
 const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
 async function invoke(action,payload){const result=await page.evaluate(({action,payload})=>window.caloraview.invoke(action,payload),{action,payload});assert.equal(result.ok,true,result.error||action+' failed');return result;}
 async function waitValid(){await page.waitForFunction(algorithm=>window.generatedEvidence?.latest?.temperatures&&window.generatedEvidence.latest.calibration?.algorithm===algorithm,ALGORITHM,{timeout:90000});return page.evaluate(()=>window.generatedEvidence.latest);}
 function validateEnvironment(actual){const configured=expected.measurementEnvironment;assert(actual);if(configured.reflectedManualOverride===false){assert(Number.isFinite(actual.reflectedC));assert.deepEqual({...actual,reflectedC:configured.reflectedC},configured);}else assert.deepEqual(actual,configured);}
 function validateFrame(frame){assert.equal(frame.calibration.algorithm,ALGORITHM);assert.equal(frame.calibration.generatedReference,true);assert.equal(frame.calibration.status,'factory-calibrated');validateEnvironment(frame.calibration.environment);assert.deepEqual(frame.calibration.configuredEnvironment,expected.measurementEnvironment);for(const k of['center','high','low'])assert(Number.isFinite(frame.temperatures[k]));}
 function validateSnapshot(folder){const snap=readJson(path.join(folder,'measurement.json'));assert.equal(snap.factoryCalibration?.algorithm,ALGORITHM);assert.equal(snap.factoryCalibration.generatedReference,true);validateEnvironment(snap.environment);assert.deepEqual(snap.factoryCalibration.environment,snap.environment);assert.deepEqual(snap.configuredEnvironment,expected.measurementEnvironment);assert.equal(snap.displayTemperatureUnit,expected.temperatureUnit);return snap;}
 try{
  desktop=await electron.launch(executable?{executablePath:executable,args:[],env}:{args:[root],env});page=await desktop.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>!!window.caloraview&&[...document.querySelectorAll('#device-select option')].some(o=>/vid_38be&pid_0184/i.test(o.value)),null,{timeout:20000});
  const initial=await invoke('state');assert.deepEqual(initial.measurementEnvironment,expected.measurementEnvironment);assert.equal(initial.temperatureUnit,expected.temperatureUnit);
  await page.evaluate(()=>{window.generatedEvidence={latest:null,frames:0,algorithms:[]};window.caloraview.onFrame(f=>{const e=window.generatedEvidence;e.frames++;e.latest={sequence:f.sequence,timestamp:f.timestamp,temperatures:f.temperatures,calibration:f.calibration,measurementSample:f.measurementSample};if(f.temperatures&&!e.algorithms.includes(f.calibration?.algorithm))e.algorithms.push(f.calibration?.algorithm);});});
  const device=await page.locator('#device-select option').evaluateAll(options=>options.find(o=>/vid_38be&pid_0184/i.test(o.value)).value);
  await page.selectOption('#device-select',device);await invoke('connect',{device});
  report.beforeReapply=await waitValid();validateFrame(report.beforeReapply);
  report.firstSnapshot=(await invoke('snapshot')).folder;validateSnapshot(report.firstSnapshot);
  await page.evaluate(()=>{window.generatedEvidence.latest=null;});
  await invoke('settings',{measurementEnvironment:expected.measurementEnvironment});
  await page.evaluate(()=>{window.generatedEvidence.latest=null;});
  report.afterReapply=await waitValid();validateFrame(report.afterReapply);assert.equal(report.afterReapply.calibration.environment.reflectedC,report.beforeReapply.calibration.environment.reflectedC);assert(report.afterReapply.sequence>report.beforeReapply.sequence,'Expected a new frame after recreating radiometry');
  const updated=await invoke('state');assert.deepEqual(updated.measurementEnvironment,expected.measurementEnvironment);assert.equal(updated.temperatureUnit,expected.temperatureUnit);
  report.secondSnapshot=(await invoke('snapshot')).folder;report.snapshot=validateSnapshot(report.secondSnapshot);
  report.logFolder=(await invoke('logStart')).folder;logging=true;
  await page.waitForTimeout(3200);
  await page.screenshot({path:path.join(output,'generated-reference-live.png'),fullPage:true});
  await invoke('logStop');logging=false;
  const session=readJson(path.join(report.logFolder,'session.json')),rows=csv(path.join(report.logFolder,'measurements.csv'));
  assert.equal(session.status,'complete');assert.equal(session.factoryCalibration?.algorithm,ALGORITHM);assert.equal(session.factoryCalibration.generatedReference,true);validateEnvironment(session.environment);assert.deepEqual(session.factoryCalibration.environment,session.environment);assert.deepEqual(session.configuredEnvironment,expected.measurementEnvironment);assert.equal(session.displayTemperatureUnit,expected.temperatureUnit);assert(rows.length>=4,'Expected multiple2Hz measurement rows');
  for(const row of rows){assert.equal(row.calibration_status,'factory-calibrated');for(const key of['center_c','high_c','low_c'])assert(row[key]!==''&&Number.isFinite(Number(row[key])));assert.equal(Number(row.room_temperature_c),expected.measurementEnvironment.ambientC);assert.equal(Number(row.relative_humidity_percent),expected.measurementEnvironment.humidityPercent);assert(Math.abs(Number(row.room_temperature_f)-(expected.measurementEnvironment.ambientC*1.8+32))<1e-10);}
  // CSV carries measurements/environment; its paired session.json establishes v3 algorithm provenance.
  report.csvRows=rows.length;report.session=session;report.evidence=await page.evaluate(()=>window.generatedEvidence);assert.deepEqual(report.evidence.algorithms,[ALGORITHM]);assert.deepEqual(errors,[]);
  await invoke('disconnect');report.status='passed';
 }catch(error){report.status='failed';report.error=error.stack||error.message;throw error;}
 finally{
  if(page&&logging)try{await page.evaluate(()=>window.caloraview.invoke('logStop'));}catch{}
  if(desktop)try{await desktop.close();}catch(e){report.closeError=e.message;report.status='failed';process.exitCode=1;}
  report.rendererErrors=errors;report.sourcePreferencesUnchanged=fs.existsSync(sourcePreferences)&&fs.readFileSync(sourcePreferences).equals(originalBytes);if(!report.sourcePreferencesUnchanged){report.status='failed';report.preferenceError='User preferences changed externally during check; smoke never writes that path';process.exitCode=1;}
  report.isolatedPreferences=loadPreferences(preferenceFile);try{assert.deepEqual(report.isolatedPreferences,expected);}catch(e){report.status='failed';report.preferenceError=e.message;process.exitCode=1;}save();console.log(JSON.stringify({status:report.status,output,algorithm:ALGORITHM,csvRows:report.csvRows,preferencesUnchanged:report.sourcePreferencesUnchanged,rendererErrors:errors}));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
