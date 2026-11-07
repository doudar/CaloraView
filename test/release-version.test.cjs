'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nextVersion, parseVersion } = require('../scripts/release-version.cjs');

test('first release increments the package baseline', () => {
  assert.equal(nextVersion('0.1.0', []), '0.1.1');
});
test('patch increments the numerically greatest stable tag', () => {
  assert.equal(nextVersion('0.1.0', ['v0.1.9', 'v0.1.10', 'v0.1.2', 'v9.0.0-beta', 'other']), '0.1.11');
  assert.equal(nextVersion('0.1.0', ['v1.9.99', 'v2.0.0']), '2.0.1');
});
test('package baseline can advance the release series', () => {
  assert.equal(nextVersion('0.2.0', ['v0.1.9']), '0.2.1');
});
test('retrying the same tagged commit reuses its version', () => {
  assert.equal(nextVersion('0.1.0', ['v0.1.1', 'v0.1.2'], ['v0.1.1']), '0.1.1');
});
test('invalid and overflowing versions are rejected', () => {
  for (const version of ['01.2.3', 'v1.2.3', '1.2.3-beta', '1.2', '1.2.9007199254740992']) assert.throws(() => parseVersion(version));
  assert.throws(() => nextVersion('1.2.9007199254740991', []));
});
