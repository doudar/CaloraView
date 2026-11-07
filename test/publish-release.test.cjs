'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../scripts/publish-release.cjs'), 'utf8');
const sha = 'a'.repeat(40);
function run(options = {}) {
  const calls = [];
  const files = ['Caloraview-Desktop-0.1.1-win-x64-Setup.exe', 'Caloraview-Desktop-0.1.1-mac-arm64-Installer.pkg'];
  const fakeFs = { readdirSync: () => options.files || (options.missing ? files.slice(1) : files), readFileSync: () => Buffer.from('synthetic package'), writeFileSync: (name, value) => calls.push(['checksum', name, value]) };
  const child = {
    spawnSync: () => ({status: options.tag ? 0 : 1, stdout: options.tag || ''}),
    execFileSync: (_command, args) => {
      calls.push(args);
      if (args[0] === 'api' && args.includes('--paginate')) return JSON.stringify([options.release ? [options.release] : []]);
      if (options.failUpload && args[1] === 'upload') throw new Error('Simulated upload failure');
      return '';
    }
  };
  let error;
  try {
    vm.runInNewContext(source, {
      require: name => name === 'node:fs' ? fakeFs : name === 'node:child_process' ? child : name === './release-version.cjs' ? require('../scripts/release-version.cjs') : require(name),
      process: {env: {RELEASE_VERSION: '0.1.1', GITHUB_SHA: sha}, exit: () => { throw new Error('EXIT'); }},
      console: {log() {}}
    });
  } catch (caught) { if (caught.message !== 'EXIT') error = caught; }
  return {calls, error, mutations: calls.filter(args => args.includes('POST') || args[0] === 'release')};
}
test('release reserves its tag, creates a draft, uploads packages/checksums, then publishes', () => {
  const {calls, error, mutations} = run();
  assert.equal(error, undefined);
  assert.deepEqual(mutations.map(args => args[0] === 'api' ? 'tag' : args[1]), ['tag', 'create', 'upload', 'edit']);
  assert.match(calls[0][2], /^[a-f0-9]{64}  Caloraview-Desktop-/);
  assert.ok(mutations[1].includes('--draft'));
  assert.ok(mutations[3].includes('--draft=false'));
});
test('failed upload leaves the reserved tag and draft without publishing', () => {
  const result = run({failUpload: true});
  assert.match(result.error.message, /upload failure/);
  assert.equal(result.mutations.some(args => args[1] === 'edit'), false);
});
test('retry resumes a matching draft without creating another tag or release', () => {
  const result = run({tag: sha, release: {tag_name:'v0.1.1', draft:true, target_commitish:sha}});
  assert.equal(result.error, undefined);
  assert.deepEqual(result.mutations.map(args => args[1]), ['upload', 'edit']);
});
test('published release rerun makes no remote changes', () => {
  const result = run({tag: sha, release: {tag_name:'v0.1.1', draft:false}});
  assert.equal(result.error, undefined);
  assert.equal(result.mutations.length, 0);
});
test('missing packages, conflicting tags and drafts abort before mutation', () => {
  for (const options of [{missing:true}, {tag:'b'.repeat(40)}, {release:{tag_name:'v0.1.1', draft:true, target_commitish:'b'.repeat(40)}}]) {
    const result = run(options);
    assert.ok(result.error);
    assert.equal(result.mutations.length, 0);
  }
});

test('release refuses older portable EXE and DMG assets', () => {
  for (const files of [
    ['Caloraview-Desktop-0.1.1-win-x64.exe', 'Caloraview-Desktop-0.1.1-mac-arm64-Installer.pkg'],
    ['Caloraview-Desktop-0.1.1-win-x64-Setup.exe', 'Caloraview-Desktop-0.1.1-mac-arm64.dmg']
  ]) {
    const result = run({files});
    assert.match(result.error.message, /Missing or unexpected release assets/);
    assert.equal(result.mutations.length, 0);
  }
});
