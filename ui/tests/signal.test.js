import test from 'node:test';
import assert from 'node:assert/strict';
import { fft, analyze, envelopePeaks, markerSet, musicalLabel, syntheticVowel } from '../signal.js';

test('FFT preserves phase and amplitude through inverse and locates a bin-centered sinusoid', () => {
  const input = Float64Array.from({ length: 1024 }, (_, i) => Math.sin(2 * Math.PI * 80 * i / 1024));
  const transformed = fft(input);
  assert.ok(Math.abs(transformed.im[80] + 512) < 1e-8);
  const reconstructed = fft(transformed.re, transformed.im, true).re;
  assert.ok(reconstructed.every((v, i) => Math.abs(v - input[i]) < 1e-10));
  assert.throws(() => fft(new Float64Array(100)));
});

test('normalized spectrum integrates to Hamming-weighted mean-square power', () => {
  const input = Float64Array.from({ length: 2048 }, (_, i) => 0.4 * Math.sin(2 * Math.PI * 1000 * i / 16000));
  const analysis = analyze(input, 16000);
  const total = analysis.db.reduce((sum, db) => sum + 10 ** (db / 10) * analysis.binHz, 0);
  assert.ok(Math.abs(total - 0.08) < 1e-5);
  const peak = analysis.db.indexOf(Math.max(...analysis.db));
  assert.equal(peak * analysis.binHz, 1000);
});

test('real cepstrum reconstructs full log magnitude; silence stays finite and has no centers', () => {
  const analysis = analyze(syntheticVowel(), 16000, 2048);
  assert.ok(analysis.cepstrum.every(Number.isFinite));
  const logSpectrum = fft(analysis.cepstrum).re;
  const i = 100;
  const windowEnergy = Array.from({ length: 2048 }, (_, k) => (0.54 - 0.46 * Math.cos(2 * Math.PI * k / 2047)) ** 2).reduce((a, b) => a + b);
  assert.ok(Math.abs(analysis.db[i] - (10 * Math.log10(2 / (16000 * windowEnergy)) + 20 * logSpectrum[i] / Math.LN10)) < 1e-8);
  const silence = analyze(new Float64Array(2048), 16000);
  assert.ok(silence.db.every(Number.isFinite));
  assert.ok(silence.formants.every(f => f.center === null && f.lower === null && f.upper === null));
  assert.throws(() => analyze(new Float64Array(10), 16000));
});

test('edges are measured asymmetrically and clipped edges remain unresolved', () => {
  const db = Float64Array.from([-20, -15, -8, -2, 0, -1, -2, -4, -9, -15, -20]);
  const [peak] = envelopePeaks(db, 100, [{ id: 'F1', bottom: 100, top: 900 }]);
  assert.equal(peak.center, 400);
  assert.ok(Math.abs(peak.lower - 283.3333333333) < 1e-6);
  assert.equal(peak.upper, 650);
  const [clipped] = envelopePeaks(db, 100, [{ id: 'F1', bottom: 100, top: 600 }]);
  assert.equal(clipped.upper, null);
});

test('all three overlay types toggle independently, including missing estimates', () => {
  const f = [{ id: 'F1', bottom: 200, top: 950, center: 730, lower: 680, upper: 790 }];
  for (const key of ['ranges', 'centers', 'bandwidth']) {
    const marks = markerSet(f, { [key]: true });
    assert.equal(marks.length, key === 'centers' ? 1 : 2);
    assert.ok(marks.every(m => m.kind === ({ ranges: 'range', centers: 'center', bandwidth: 'bandwidth' }[key])));
  }
  assert.deepEqual(markerSet(f, {}), []);
  assert.equal(markerSet([{ ...f[0], center: null, lower: null, upper: null }], { ranges: true, centers: true, bandwidth: true }).length, 2);
});

test('musical coordinate reference and octave boundaries are correct', () => {
  assert.deepEqual(musicalLabel(440), { note: 'A', octave: 4, cents: 0 });
  assert.equal(musicalLabel(261.625565).note, 'C');
  assert.equal(musicalLabel(261.625565).octave, 4);
  assert.equal(musicalLabel(442, 442).cents, 0);
  assert.equal(musicalLabel(0), null);
});
