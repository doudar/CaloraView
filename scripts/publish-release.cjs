'use strict';
// Runs only in the trusted release job after both platform builds succeed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseVersion } = require('./release-version.cjs');
const version = process.env.RELEASE_VERSION;
parseVersion(version);
const tag = 'v' + version;
const sha = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Missing release commit SHA');
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const names = [`Caloraview-Desktop-${version}-win-x64-Setup.exe`, `Caloraview-Desktop-${version}-mac-arm64-Installer.pkg`];
const folder = 'release-assets';
const files = fs.readdirSync(folder).sort();
if (files.join('\n') !== [...names].sort().join('\n')) throw new Error('Missing or unexpected release assets: ' + files.join(', '));
const checksum = names.map(name => {
  const bytes = fs.readFileSync(path.join(folder, name));
  if (!bytes.length) throw new Error('Empty release artifact: ' + name);
  return crypto.createHash('sha256').update(bytes).digest('hex') + '  ' + name;
}).join('\n') + '\n';
fs.writeFileSync(path.join(folder, 'SHA256SUMS.txt'), checksum);
// Never move a preexisting tag, including on a rerun.
const existingTag = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { encoding: 'utf8' });
if (existingTag.status === 0 && existingTag.stdout.trim() !== sha) throw new Error('Release tag points to another commit');
const releases = JSON.parse(gh(['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/releases?per_page=100'])).flat();
const release = releases.find(item => item.tag_name === tag);
if (release?.draft && release.target_commitish !== sha) throw new Error('Draft release belongs to another commit');
if (release && !release.draft) {
  if (existingTag.status !== 0) throw new Error('Published release tag could not be verified');
  console.log(`${tag} is already published; leaving it unchanged.`);
  process.exit(0);
}
// Reserve the tag before creating a draft so interrupted uploads cannot let
// another queued commit claim this version. The tag is never force-updated.
if (existingTag.status !== 0) gh(['api', '--method', 'POST', 'repos/{owner}/{repo}/git/refs', '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`]);
if (!release) gh(['release', 'create', tag, '--verify-tag', '--target', sha, '--draft', '--title', `Caloraview Desktop ${version}`, '--generate-notes']);
gh(['release', 'upload', tag, ...names.map(name => path.join(folder, name)), path.join(folder, 'SHA256SUMS.txt'), '--clobber']);
gh(['release', 'edit', tag, '--draft=false', '--latest']);
console.log(`Published ${tag} for ${sha}.`);
