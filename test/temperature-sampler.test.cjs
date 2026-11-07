'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { TemperatureSampler } = require('../src/core/temperature-sampler.cjs');
function valid(value = 20) {
  return { temperatures: { center:value,high:value+10,low:value-5,highX:10,highY:20,lowX:30,lowY:40 },
    calibration:{status:'factory-calibrated',serial:'synthetic',algorithm:'test',environment:{emissivity:.97}} };
}
function unavailable(reason) { return { temperatures:null,calibration:{status:'unavailable',reason} }; }
function input(monotonicMs, extra = {}) {
  return { monotonicMs,timestamp:1700000000000+monotonicMs,sequence:Math.round(monotonicMs)+1,available:true,evaluate:()=>valid(),...extra };
}
test('25fps video yields exactly two samples per second over a long run with anchored deadlines', () => {
  const sampler = new TemperatureSampler(), sampled = []; let calls = 0;
  for (let time = 0; time < 60000; time += 40) {
    const result = sampler.sample(input(time,{evaluate:()=>{calls++;return valid(time);}}));
    if (result.measurementSample.fresh) sampled.push(time);
  }
  assert.equal(calls,120); assert.equal(sampled.length,120);
  assert.deepEqual(sampled.slice(0,7),[0,520,1000,1520,2000,2520,3000]);
  for (let i=0;i<sampled.length;i++) assert.ok(sampled[i]>=i*500&&sampled[i]<i*500+40);
});
test('stalls emit one current sample and restart cadence without catch-up bursts', () => {
  const sampler = new TemperatureSampler();
  assert.equal(sampler.sample(input(10)).measurementSample.fresh,true);
  const delayed = sampler.sample(input(5011));
  assert.deepEqual(delayed.measurementSample,{fresh:true,timestamp:1700000005011,monotonicMs:5011,sequence:5012});
  assert.equal(sampler.sample(input(5011)).measurementSample.fresh,false);
  assert.equal(sampler.sample(input(5051)).measurementSample.fresh,false);
  assert.equal(sampler.sample(input(5510)).measurementSample.fresh,false);
  assert.equal(sampler.sample(input(5511)).measurementSample.fresh,true);
  sampler.reset(); sampler.sample(input(0));
  assert.equal(sampler.sample(input(4999)).measurementSample.fresh,true);
  assert.equal(sampler.sample(input(5000)).measurementSample.fresh,false);
  assert.equal(sampler.sample(input(5499)).measurementSample.fresh,true);
});
test('unavailability clears held values and updates reason immediately; recovery waits for next sample', () => {
  const sampler = new TemperatureSampler(); let calls=0;
  const evaluate=()=>{calls++;return valid(calls);};
  const first=sampler.sample(input(0,{evaluate})); assert.ok(first.temperatures);
  const invalid=sampler.sample(input(40,{available:false,unavailable:unavailable('shutter-active'),evaluate}));
  assert.equal(invalid.temperatures,null); assert.equal(invalid.calibration.reason,'shutter-active');
  assert.deepEqual(invalid.measurementSample,{fresh:false,timestamp:1700000000000,monotonicMs:0,sequence:1});
  const other=sampler.sample(input(80,{available:false,unavailable:unavailable('sensor-drift'),evaluate}));
  assert.equal(other.calibration.reason,'sensor-drift');
  const recovered=sampler.sample(input(120,{evaluate})); assert.equal(recovered.temperatures,null); assert.equal(calls,1);
  const next=sampler.sample(input(520,{evaluate})); assert.equal(next.temperatures.center,2); assert.equal(next.measurementSample.sequence,521);
});
test('invalid rows maintain sampling cadence and cannot retain calibrated caller data', () => {
  const sampler=new TemperatureSampler();
  const first=sampler.sample(input(0,{available:false,unavailable:valid()}));
  assert.equal(first.temperatures,null); assert.equal(first.calibration.status,'unavailable');
  assert.equal(first.measurementSample.fresh,true);
  assert.equal(sampler.sample(input(40,{available:false})).measurementSample.fresh,false);
  const due=sampler.sample(input(520,{available:false,unavailable:unavailable('reference-required')}));
  assert.equal(due.measurementSample.fresh,true); assert.equal(due.measurementSample.sequence,521);
  assert.equal(sampler.sample(input(560)).temperatures,null);
});
test('held snapshots cannot be mutated by caller or evaluator and retain sampled frame identity', () => {
  const sampler=new TemperatureSampler(), measurement=valid(22);
  const sampled=sampler.sample(input(0,{evaluate:()=>measurement}));
  measurement.temperatures.high=999; sampled.temperatures.center=999;
  sampled.calibration.environment.emissivity=.1; sampled.measurementSample.sequence=999;
  const held=sampler.sample(input(40,{evaluate:()=>{throw Error('Should not evaluate held frame');}}));
  assert.deepEqual(held.temperatures,valid(22).temperatures);
  assert.equal(held.calibration.environment.emissivity,.97);
  assert.deepEqual(held.measurementSample,{fresh:false,timestamp:1700000000000,monotonicMs:0,sequence:1});
});
test('wall-clock jumps never change cadence; reset and monotonic rollback start a new epoch', () => {
  const sampler=new TemperatureSampler();
  sampler.sample(input(100,{timestamp:10000}));
  const held=sampler.sample(input(140,{timestamp:-10000}));
  assert.equal(held.measurementSample.timestamp,10000); assert.equal(held.measurementSample.fresh,false);
  const next=sampler.sample(input(600,{timestamp:-9000}));
  assert.equal(next.measurementSample.timestamp,-9000); assert.equal(next.measurementSample.fresh,true);
  sampler.reset(); assert.equal(sampler.sample(input(640)).measurementSample.fresh,true);
  assert.equal(sampler.sample(input(0)).measurementSample.fresh,true);
});
test('evaluator failures do not advance the next due sample', () => {
  const sampler=new TemperatureSampler();
  sampler.sample(input(0));
  assert.throws(()=>sampler.sample(input(500,{evaluate:()=>{throw Error('Conversion failed');}})),/Conversion failed/);
  assert.equal(sampler.sample(input(540)).measurementSample.fresh,true);
  assert.throws(()=>new TemperatureSampler({intervalMs:0}),/interval/);
  assert.throws(()=>sampler.sample(input(NaN)),/clocks/);
});
