'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function parseVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Expected stable major.minor.patch version: ' + value);
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Version exceeds safe integer range');
  return parts;
}
function compare(a, b) {
  const aa = parseVersion(a), bb = parseVersion(b);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return 0;
}
function stableTags(tags) { return tags.filter(tag => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)).map(tag => tag.slice(1)); }
function nextVersion(baseline, tags, headTags = []) {
  parseVersion(baseline);
  const existing = stableTags(headTags).sort(compare).at(-1);
  if (existing) return existing; // Resume a tagged draft or rerun a published commit.
  const latest = [baseline, ...stableTags(tags)].sort(compare).at(-1);
  const parts = parseVersion(latest);
  parts[2]++;
  const result = parts.join('.'); parseVersion(result);
  return result;
}
function setVersion(version) {
  parseVersion(version);
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  pkg.version = lock.version = lock.packages[''].version = version;
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
}
if (require.main === module) {
  if (process.argv[2] === '--set' && process.argv.length === 4) setVersion(process.argv[3]);
  else if (process.argv.length === 2) {
    const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
    const version = nextVersion(require('../package.json').version, git(['tag', '--list']), git(['tag', '--points-at', 'HEAD']));
    console.log(version);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=v${version}\n`);
  } else throw new Error('Usage: node scripts/release-version.cjs [--set major.minor.patch]');
}
module.exports = { nextVersion, parseVersion };
