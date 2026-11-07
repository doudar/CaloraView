'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../scripts/research/normalize-host-metadata.cjs');
const state = { sensorIdentity: m.SENSOR_ID, fpaWord: 1350, cachedCavWord: 1526, processorSelector: 3 };

test('additional extraction copies six 512-byte rows and skips USB padding', () => {
  const raw = Buffer.alloc(m.FRAME_BYTES, 0xee);
  for (let row = 0; row < 6; row++) raw.fill(row + 1, (216 + row) * 528, (216 + row) * 528 + 512);
  const compact = m.extractCompactAdditional(raw);
  assert.equal(compact.length, 3072);
  for (let row = 0; row < 6; row++) assert.ok(compact.subarray(row * 512, (row + 1) * 512).every(x => x === row + 1));
  assert.equal(raw[216 * 528 + 512], 0xee);
  assert.throws(() => m.extractCompactAdditional(raw.subarray(2)), /Expected one/);
});

test('verified header writes preserve all other bytes and never alter the source', () => {
  const raw = Buffer.alloc(m.COMPACT_BYTES, 0xa5);
  const result = m.rewriteSk02HostHeader(raw, state);
  const fields = [[0,1350],[5,1],[8,192],[9,256],[13,2],[20,1526]];
  const touched = new Set(fields.flatMap(([word]) => [word * 2, word * 2 + 1]));
  for (const [word,value] of fields) assert.equal(result.readUInt16LE(word * 2), value);
  for (let i = 0; i < result.length; i++) if (!touched.has(i)) assert.equal(result[i], 0xa5);
  assert.ok(raw.every(x => x === 0xa5));
  assert.equal(m.researchOnly, true);
  assert.equal(m.sceneAccuracyValidated, false);
});

test('host states cannot silently default to a usable frame', () => {
  const raw = Buffer.alloc(m.COMPACT_BYTES);
  for (const name of Object.keys(state)) {
    const missing = { ...state }; delete missing[name];
    assert.throws(() => m.rewriteSk02HostHeader(raw, missing));
  }
  for (const patch of [{sensorIdentity:'065356AA00'}, {fpaWord:NaN}, {fpaWord:-1}, {cachedCavWord:0}, {cachedCavWord:0x4000}, {processorSelector:0}, {processorSelector:6}]) {
    assert.throws(() => m.rewriteSk02HostHeader(raw, {...state,...patch}));
  }
  assert.throws(() => m.rewriteSk02HostHeader(Buffer.alloc(1024), state), /six compact/);
});

test('resolved validity writes native uint16 and uint32 fields while preserving word7', () => {
  const raw = Buffer.alloc(m.COMPACT_BYTES, 0xa5);
  for (const flag of [0,1]) {
    const result = m.applyResolvedHostValidity(raw, flag);
    assert.equal(result.readUInt16LE(12), flag);
    assert.equal(result.readUInt16LE(14), 0xa5a5);
    assert.equal(result.readUInt32LE(540), flag);
    for (let i = 0; i < result.length; i++) if (![12,13,540,541,542,543].includes(i)) assert.equal(result[i], raw[i]);
  }
  for (const invalid of [undefined,null,2,-1,true]) assert.throws(() => m.applyResolvedHostValidity(raw, invalid));
  assert.ok(raw.every(x => x === 0xa5));
});

test('aggregate and secondary validity are independently representable', () => {
  const result = m.applyResolvedHostValidity(Buffer.alloc(m.COMPACT_BYTES), 1, 0);
  assert.equal(result.readUInt16LE(12), 1);
  assert.equal(result.readUInt32LE(540), 0);
  assert.throws(() => m.applyResolvedHostValidity(Buffer.alloc(m.COMPACT_BYTES), 0, 2));
});
