'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { transformPreview } = require('../src/core/display-transform.cjs');
function frame() {
  const rgba = Buffer.from([1,2,3,4,5,6].flatMap(value => [value, value + 20, value + 40, 255]));
  return { rgba, width: 3, height: 2, stats: { center: 5, high: 6, low: 1, highX: 2, highY: 1, lowX: 0, lowY: 0 },
    temperatures: { center: 22, high: 32, low: 12, highX: 1, highY: 0, lowX: 1, lowY: 1 },
    calibration: { status: 'factory-calibrated' }, detector: new Uint16Array([100,200,300,400,500,600]) };
}
test('exact clockwise rotations preserve all channels on a non-square image', () => {
  for (const [rotation, width, height, reds] of [[0,3,2,[1,2,3,4,5,6]],[90,2,3,[4,1,5,2,6,3]],
    [180,3,2,[6,5,4,3,2,1]],[270,2,3,[3,6,2,5,1,4]]]) {
    const output = transformPreview(frame(), { rotation });
    assert.equal(output.width, width); assert.equal(output.height, height);
    assert.deepEqual([...output.rgba].filter((_, i) => i % 4 === 0), reds);
    for (let i = 0; i < reds.length; i++) assert.deepEqual([...output.rgba.subarray(i*4,i*4+4)], [reds[i],reds[i]+20,reds[i]+40,255]);
  }
});
test('enhancement doubles display dimensions, preserves uniform fields and bounds edges', () => {
  const uniform = { width: 2, height: 3, rgba: Buffer.from(Array(6).fill([37,89,123,255]).flat()) };
  const output = transformPreview(uniform, { resolution: 'enhanced' });
  assert.equal(output.width, 4); assert.equal(output.height, 6);
  assert.deepEqual([...output.rgba], Array(24).fill([37,89,123,255]).flat());
  const edge = { width: 2, height: 1, rgba: Buffer.from([0,0,0,255,255,255,255,255]) };
  const values = [...transformPreview(edge, { resolution: 'enhanced' }).rgba].filter((_, i) => i % 4 === 0);
  assert.deepEqual(values.slice(0,4), [0,52,203,255]);
  assert.ok(values.every(value => value >= 0 && value <= 255));
});
test('markers follow pixel centers through enhancement and clockwise rotation', () => {
  const input = frame(), output = transformPreview(input, { resolution: 'enhanced', rotation: 90 });
  assert.equal(output.width, 4); assert.equal(output.height, 6);
  assert.deepEqual(output.displayMarkers, { source: 'temperature', center: { x:.5,y:2.5 }, high: { x:2.5,y:2.5 }, low: { x:.5,y:2.5 } });
  input.calibration.status = 'unavailable';
  const raw = transformPreview(input, { rotation: 270 });
  assert.deepEqual(raw.displayMarkers, { source: 'detector', center: { x:1,y:1 }, high: { x:1,y:0 }, low: { x:0,y:2 } });
});
test('transforms never mutate or interpolate detector data, temperatures or native coordinates', () => {
  const input = frame(), before = structuredClone(input), output = transformPreview(input, { resolution: 'enhanced', rotation: 180 });
  assert.deepEqual([...input.rgba], [...before.rgba]);
  assert.deepEqual(input.stats, before.stats); assert.deepEqual(input.temperatures, before.temperatures);
  assert.strictEqual(output.stats, input.stats); assert.strictEqual(output.temperatures, input.temperatures);
  assert.strictEqual(output.detector, input.detector);
  output.rgba.fill(0); assert.deepEqual([...input.rgba], [...before.rgba]);
  const native = transformPreview(input); native.rgba.fill(0); assert.deepEqual([...input.rgba], [...before.rgba]);
});
test('invalid input or settings fail clearly; invalid temperature coordinates use detector markers', () => {
  for (const options of [{ rotation:45 },{ rotation:'90' },{ resolution:'ai' }]) assert.throws(() => transformPreview(frame(), options), /Unsupported/);
  assert.throws(() => transformPreview({ width:2,height:2,rgba:Buffer.alloc(2) }), /RGBA/);
  const input = frame(); input.temperatures.highX = 3;
  assert.equal(transformPreview(input).displayMarkers.source, 'detector');
  assert.equal(transformPreview({ width:1,height:1,rgba:Buffer.alloc(4) }).displayMarkers.high, null);
});
