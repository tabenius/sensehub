// Prototype analysis, separate from the production Rust DSP. No dependencies.
export const BANDS = [
  { id: 'F1', bottom: 200, top: 950 },
  { id: 'F2', bottom: 950, top: 1900 },
  { id: 'F3', bottom: 1900, top: 3400 },
];

export function fft(real, imaginary = new Float64Array(real.length), inverse = false) {
  const n = real.length;
  if (n < 2 || (n & (n - 1)) || imaginary.length !== n) throw new Error('FFT requires equal power-of-two arrays.');
  const re = Float64Array.from(real), im = Float64Array.from(imaginary);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(angle), wi = Math.sin(angle);
    for (let base = 0; base < n; base += len) {
      let ur = 1, ui = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = base + j, b = a + len / 2;
        const vr = re[b] * ur - im[b] * ui, vi = re[b] * ui + im[b] * ur;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        [ur, ui] = [ur * wr - ui * wi, ur * wi + ui * wr];
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  return { re, im };
}

export function musicalLabel(hz, reference = 440) {
  if (!(hz > 0) || !(reference > 0)) return null;
  const midi = 69 + 12 * Math.log2(hz / reference), nearest = Math.round(midi);
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  return { note: names[((nearest % 12) + 12) % 12], octave: Math.floor(nearest / 12) - 1, cents: 100 * (midi - nearest) };
}

function crossing(db, start, end, direction, level, binHz) {
  for (let i = start + direction; direction > 0 ? i <= end : i >= end; i += direction) {
    if (db[i] <= level) {
      const previous = i - direction;
      const fraction = (level - db[previous]) / (db[i] - db[previous]);
      return (previous + direction * fraction) * binHz;
    }
  }
  return null; // unresolved/clipped edge; never manufacture symmetry
}

export function envelopePeaks(db, binHz, bands = BANDS, audible = true) {
  return bands.map(band => {
    const result = { ...band, center: null, lower: null, upper: null, prominence: null, status: 'missing' };
    if (!audible) return result;
    const low = Math.max(1, Math.ceil(band.bottom / binHz));
    const high = Math.min(db.length - 2, Math.floor(band.top / binHz));
    let best = -1;
    for (let i = low + 1; i < high; i++) {
      if (db[i] > db[i - 1] && db[i] >= db[i + 1] && (best < 0 || db[i] > db[best])) best = i;
    }
    if (best < 0) return result;
    const background = Array.from(db.slice(low, high + 1)).sort((a, b) => a - b);
    const prominence = db[best] - background[Math.floor(background.length / 2)];
    if (prominence < 3) return result;
    return { ...result, center: best * binHz, prominence, status: 'observed envelope peak',
      lower: crossing(db, best, low, -1, db[best] - 3, binHz),
      upper: crossing(db, best, high, 1, db[best] - 3, binHz) };
  });
}

export function analyze(samples, sampleRate, start = 0, size = 2048) {
  if (!(sampleRate > 0) || !Number.isInteger(start) || start < 0 || start + size > samples.length) throw new Error('Select a full valid audio frame.');
  const frame = new Float64Array(size);
  let mean = 0, energy = 0, windowEnergy = 0;
  for (let i = 0; i < size; i++) mean += samples[start + i] / size;
  for (let i = 0; i < size; i++) {
    const value = samples[start + i] - mean;
    const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (size - 1));
    frame[i] = value * w; energy += value * value / size; windowEnergy += w * w;
  }
  const { re, im } = fft(frame);
  const logMagnitude = Float64Array.from(re, (v, i) => Math.log(Math.max(1e-12, Math.hypot(v, im[i]))));
  const cepstrum = fft(logMagnitude, undefined, true).re;
  // Symmetric low-quefrency lifter. This is an envelope, not a pole model.
  const cutoff = Math.min(size / 2 - 1, Math.round(0.002 * sampleRate));
  const lifted = Float64Array.from(cepstrum, (v, i) => i <= cutoff || i >= size - cutoff ? v : 0);
  const logEnvelope = fft(lifted).re;
  const db = new Float64Array(size / 2 + 1), envelope = new Float64Array(db.length);
  for (let k = 0; k < db.length; k++) {
    const factor = k === 0 || k === size / 2 ? 1 : 2;
    const scale = factor / (sampleRate * windowEnergy);
    db[k] = 10 * Math.log10(Math.max(1e-24, scale * (re[k] ** 2 + im[k] ** 2)));
    envelope[k] = 10 * Math.log10(scale) + 20 * logEnvelope[k] / Math.LN10;
  }
  return { db, envelope, cepstrum, sampleRate, size, binHz: sampleRate / size,
    time: (start + (size - 1) / 2) / sampleRate, start,
    formants: envelopePeaks(envelope, sampleRate / size, BANDS, energy > 1e-10) };
}

export function syntheticVowel(sampleRate = 16000, seconds = 3) {
  const samples = new Float32Array(Math.ceil(seconds * sampleRate));
  const poles = [[730, 100], [1090, 110], [2440, 140]];
  const states = poles.map(() => [0, 0]);
  const coefficients = poles.map(([f, bw]) => { const r = Math.exp(-Math.PI * bw / sampleRate); return [2 * r * Math.cos(2 * Math.PI * f / sampleRate), r * r]; });
  let random = 123456789, phase = 0, peak = 0;
  for (let i = 0; i < samples.length; i++) {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    const oldPhase = phase; phase = (phase + (120 + 15 * Math.sin(2 * Math.PI * i / sampleRate)) / sampleRate) % 1;
    const drive = (phase < oldPhase ? 1 : 0) + ((random >>> 0) / 4294967295 - 0.5) * 0.1;
    let sum = 0;
    coefficients.forEach(([a, b], j) => { const [s1, s2] = states[j]; const v = drive + a * s1 - b * s2; states[j] = [v, s1]; sum += v; });
    samples[i] = sum; peak = Math.max(peak, Math.abs(sum));
  }
  for (let i = 0; i < samples.length; i++) samples[i] *= 0.8 / peak;
  return samples;
}

export function markerSet(formants, prefs) {
  const markers = [];
  for (const f of formants) {
    if (prefs.ranges) for (const hz of [f.bottom, f.top]) markers.push({ id: f.id, hz, kind: 'range' });
    if (prefs.centers && f.center !== null) markers.push({ id: f.id, hz: f.center, kind: 'center' });
    if (prefs.bandwidth) for (const hz of [f.lower, f.upper]) if (hz !== null) markers.push({ id: f.id, hz, kind: 'bandwidth' });
  }
  return markers;
}
