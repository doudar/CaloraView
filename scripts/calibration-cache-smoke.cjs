// Explicit real-camera test: first-use download and reuse after an app restart.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const parent = path.resolve('test-output'); fs.mkdirSync(parent, { recursive: true });
  const output = fs.mkdtempSync(path.join(parent, 'persistent-calibration-'));
  const cache = path.join(output, 'cache');
  let firstFolder;
  let firstSerial;
  for (const expected of ['download', 'cache']) {
    const desktop = await electron.launch({
      ...(process.env.CALORAVIEW_TEST_PACKAGED ? { executablePath: path.resolve('dist/win-unpacked/Caloraview Desktop.exe'), args: [] } : { args: [path.resolve('.')] }),
      env: { ...process.env, CALORAVIEW_OUTPUT: output, CALORAVIEW_CALIBRATION_DIR: cache, CALORAVIEW_PREFERENCES_PATH: path.join(output, 'preferences.json') }
    });
    try {
      const page = await desktop.firstWindow();
      await page.waitForFunction(() => [...document.querySelectorAll('#device-select option')].some(o => /vid_38be&pid_0184/i.test(o.value)), { timeout: 15000 });
      const device = await page.locator('#device-select option').evaluateAll(options => options.find(o => /vid_38be&pid_0184/i.test(o.value)).value);
      await page.selectOption('#device-select', device);
      await page.click('#connect-btn');
      await page.waitForFunction(() => document.querySelector('#raw-center').textContent !== '—', { timeout: 90000 });
      const state = await page.evaluate(() => window.caloraview.invoke('state'));
      assert.equal(state.calibrationError, null);
      assert.equal(state.temperatureUnit, expected === 'download' ? 'C' : 'F');
      assert.equal(await page.locator('#temperature-unit-select').inputValue(), expected === 'download' ? 'C' : 'F');
      if (expected === 'download') {
        await page.selectOption('#temperature-unit-select', 'F');
        await page.waitForFunction(() => document.querySelector('#temp-center').textContent.includes('\u00b0F'));
      }
      assert.equal(state.calibrationDownloaded, true);
      assert.equal(state.calibrationSource, expected);
      assert.match(state.calibrationSerial, /^A43EB0_/);
      if (firstSerial) assert.equal(state.calibrationSerial, firstSerial);
      else firstSerial = state.calibrationSerial;
      if (firstFolder) assert.equal(state.calibrationFolder, firstFolder);
      else firstFolder = state.calibrationFolder;
      await page.waitForFunction(() => /^-?\d/.test(document.querySelector('#temp-center').textContent), { timeout: 15000 });
      await page.screenshot({ path: path.join(output, `${expected}.png`), fullPage: true });
      console.log(JSON.stringify({ session: expected, serial: state.calibrationSerial, folder: state.calibrationFolder }));
    } finally { await desktop.close(); }
  }
  assert.equal(fs.readdirSync(cache).filter(name => name.endsWith('.json')).length, 1);
  console.log('Camera calibration and Fahrenheit preference persisted across a full app restart.');
})().catch(error => { console.error(error); process.exitCode = 1; });
