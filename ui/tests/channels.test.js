import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChannel, processChannel, debounce, atTime, channelStats, exportChannel } from '../channels.js';

test('char arrays, bit strings and unknowns retain explicit sample timing', () => {
  const bits = parseChannel('0 1 ? 0', { intervalUs: 20 });
  const chars = parseChannel('["0","1",null,"0"]', { intervalUs: 20 });
  assert.deepEqual(bits.points, chars.points);
  assert.equal(bits.endUs, 80);
  assert.equal(atTime(bits, 35), 1);
  assert.equal(atTime(bits, 50), null);
  assert.equal(atTime(bits, 80), null);
  assert.throws(() => parseChannel('012'));
  assert.throws(() => parseChannel('01', { intervalUs: 0 }));
});

test('timestamped provenance roundtrips and invalid timing is rejected', () => {
  const envelope = { schemaVersion: 1, name: 'PIR', kind: 'digital', stage: 'detected', data: {
    encoding: 'edges', points: [{ tUs: 100, value: 'LOW' }, { tUs: 400, value: 'HIGH' }], endUs: 1000 } };
  const channel = parseChannel(JSON.stringify(envelope));
  assert.equal(channel.stage, 'detected');
  assert.deepEqual(parseChannel(JSON.stringify(exportChannel(channel))).points, channel.points);
  const filtered = exportChannel(processChannel(channel, { invert: true }));
  const roundtrip = parseChannel(JSON.stringify(filtered));
  assert.equal(roundtrip.provenance.pipeline.invert, true);
  assert.equal(exportChannel(processChannel(roundtrip)).provenance.input.pipeline.invert, true);
  envelope.data.points[1].tUs = 100;
  assert.throws(() => parseChannel(JSON.stringify(envelope)), /strictly increasing/);
  assert.throws(() => parseChannel('{"schemaVersion":1,"kind":"image","data":{}}'));
});

test('stable-time debounce rejects bounce, reports delay and does not bridge unknown intervals', () => {
  const channel = parseChannel('000101111000', { intervalUs: 1000 });
  const processed = processChannel(channel, { debounceUs: 2000 });
  assert.deepEqual(processed.points, [
    { tUs: 0, value: null }, { tUs: 2000, value: 0 }, { tUs: 7000, value: 1 }, { tUs: 11000, value: 0 },
  ]);
  const gaps = parseChannel('11?111', { intervalUs: 1000 });
  assert.deepEqual(debounce(gaps.points, gaps.endUs, 2000), [
    { tUs: 0, value: null }, { tUs: 5000, value: 1 },
  ]);
});

test('hysteresis, inversion and filter state handle the dead band and missing data', () => {
  const input = parseChannel('[0.1,0.5,0.8,0.5,0.2,null,0.5,0.9]', { numeric: true });
  const processed = processChannel(input, { low: 0.3, high: 0.7 });
  assert.equal(processed.stage, 'detected');
  assert.deepEqual(input.points.map(p => atTime(processed, p.tUs)), [0, 0, 1, 1, 0, null, null, 1]);
  const inverted = processChannel(input, { low: 0.3, high: 0.7, invert: true });
  assert.deepEqual(input.points.map(p => atTime(inverted, p.tUs)), [1, 1, 0, 0, 1, null, null, 0]);
  assert.throws(() => processChannel(input, { low: 1, high: 0 }));
  assert.throws(() => processChannel(input, { emaAlpha: 0 }));
  assert.equal(input.points[2].value, 0.8); // raw input untouched
});

test('statistics exclude unknown durations and never infer edges across gaps', () => {
  const channel = processChannel(parseChannel('01?10', { intervalUs: 1000 }));
  const stats = channelStats(channel);
  assert.equal(stats.knownUs, 4000);
  assert.equal(stats.highUs, 2000);
  assert.equal(stats.duty, 0.5);
  assert.equal(stats.rising, 1);
  assert.equal(stats.falling, 1);
  assert.equal(channelStats(processChannel(parseChannel('???'))).duty, null);
});

test('causal median rejects isolated outlier and EMA resets across gaps', () => {
  const channel = parseChannel('[0,0,10,0,0,null,10]', { numeric: true });
  const median = processChannel(channel, { low: 2, high: 8, median: true });
  assert.equal(atTime(median, 2000), 0);
  assert.equal(atTime(median, 6000), 1);
  const ema = processChannel(channel, { low: 2, high: 8, emaAlpha: 0.1 });
  assert.equal(atTime(ema, 2000), 0);
  assert.equal(atTime(ema, 6000), 1);
});

test('numeric units and effective detection parameters stay explicit in exports', () => {
  const input = parseChannel(JSON.stringify({schemaVersion:1,name:'Photodiode',kind:'numeric',stage:'raw',unit:'V',data:{encoding:'samples',intervalUs:1000,values:[0.1,0.9]}}));
  assert.equal(input.unit, 'V');
  const exported = exportChannel(processChannel(input));
  assert.equal(exported.unit, 'logic');
  assert.equal(exported.provenance.pipeline.low, 0.3);
  assert.equal(exported.provenance.pipeline.high, 0.7);
});
