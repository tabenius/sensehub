import { analyze, syntheticVowel, markerSet, musicalLabel } from './signal.js';
import './channel-ui.js';

const defaults = { centers: true, ranges: true, bandwidth: true, notes: false, octaves: false, hover: true,
  fields: { position: true, value: true, time: true, music: false, formant: true, evidence: true, settings: false }, reference: 440 };
const prefs = structuredClone(defaults);
try {
  const stored = JSON.parse(localStorage.getItem('sensehub.display.v1'));
  if (stored) {
    for (const key of ['centers', 'ranges', 'bandwidth', 'notes', 'octaves', 'hover']) if (typeof stored[key] === 'boolean') prefs[key] = stored[key];
    for (const key of Object.keys(prefs.fields)) if (typeof stored.fields?.[key] === 'boolean') prefs.fields[key] = stored.fields[key];
    if (Number.isFinite(stored.reference) && stored.reference >= 400 && stored.reference <= 480) prefs.reference = stored.reference;
  }
} catch { /* Storage may be disabled; controls still work. */ }

let samples, sampleRate = 16000, result, selected = 'F1', inspection = null, loadGeneration = 0;
const slider = document.querySelector('#frame');
const info = document.querySelector('#inspection');
const views = ['spectrum', 'cepstrum'].map(id => ({ id, canvas: document.getElementById(id), fraction: 0.4, geometry: null }));
const colors = { range: '#9aadc9', center: '#ffb366', bandwidth: '#b4cf89' };
const hz = value => value === null ? 'unresolved' : `${value.toFixed(0)} Hz`;
function persist() { try { localStorage.setItem('sensehub.display.v1', JSON.stringify(prefs)); } catch { /* optional */ } }

document.querySelectorAll('[data-pref], [data-field]').forEach(input => {
  input.checked = input.dataset.pref ? prefs[input.dataset.pref] : prefs.fields[input.dataset.field];
  input.addEventListener('change', () => {
    if (input.dataset.pref) prefs[input.dataset.pref] = input.checked;
    else prefs.fields[input.dataset.field] = input.checked;
    persist(); render();
  });
});
const reference = document.querySelector('#reference');
reference.value = prefs.reference;
reference.addEventListener('change', () => {
  const value = Number(reference.value);
  if (!Number.isFinite(value) || value < 400 || value > 480) { reference.value = prefs.reference; return; }
  prefs.reference = value; persist(); render();
});

function setSource(data, rate, name) {
  if (data.length < 2048) throw new Error('Audio must contain at least 2048 samples.');
  samples = data; sampleRate = rate;
  slider.max = Math.floor((samples.length - 2048) / 256) * 256;
  slider.value = Math.min(2048, Number(slider.max));
  document.getElementById('source-name').textContent = `${name} · ${(samples.length / rate).toFixed(2)} s · ${rate} Hz`;
  update();
}
document.getElementById('demo').addEventListener('click', () => {
  loadGeneration++; setSource(syntheticVowel(), 16000, 'Synthetic /a/-like signal');
});
document.getElementById('file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  const generation = ++loadGeneration;
  let context;
  try {
    document.getElementById('source-name').textContent = `Decoding ${file.name}…`;
    context = new AudioContext();
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    if (generation !== loadGeneration) return;
    const mono = new Float32Array(buffer.length);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const channel = buffer.getChannelData(ch);
      for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / buffer.numberOfChannels;
    }
    setSource(mono, buffer.sampleRate, file.name);
  } catch (error) {
    if (generation === loadGeneration) document.getElementById('source-name').textContent = `Could not load audio: ${error.message}. Previous frame retained.`;
  } finally { if (context) await context.close(); }
});
slider.addEventListener('input', update);
function update() {
  result = analyze(samples, sampleRate, Number(slider.value));
  document.getElementById('time').textContent = `${result.time.toFixed(3)} s`;
  render();
}

function draw(view) {
  const { canvas, id } = view;
  const width = canvas.getBoundingClientRect().width, height = canvas.getBoundingClientRect().height;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const musicalAxis = id === 'spectrum' && (prefs.notes || prefs.octaves);
  const left = 62, right = width - 12, top = 30, bottom = height - (musicalAxis ? 56 : 35);
  const maximum = id === 'spectrum' ? Math.min(4000, sampleRate / 2) : Math.min(20, (result.size / 2 - 1) * 1000 / sampleRate);
  const data = id === 'spectrum' ? result.db : result.cepstrum;
  const spacing = id === 'spectrum' ? result.binHz : 1000 / sampleRate;
  const last = Math.min(data.length - 1, Math.floor(maximum / spacing));
  let minimumY, maximumY;
  if (id === 'spectrum') {
    const peak = Math.max(-100, ...result.db.slice(0, last + 1), ...result.envelope.slice(0, last + 1));
    maximumY = Math.ceil(peak / 10) * 10 + 10; minimumY = maximumY - 90;
  } else {
    let extent = 0.02;
    for (let i = 1; i <= last; i++) extent = Math.max(extent, Math.abs(data[i]));
    minimumY = -extent * 1.15; maximumY = extent * 1.15;
  }
  const x = value => left + (right - left) * value / maximum;
  const y = value => bottom - (bottom - top) * (value - minimumY) / (maximumY - minimumY);
  view.geometry = { left, right, maximum, spacing, last };
  ctx.font = '11px system-ui'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#b7bbad';
  for (let i = 0; i <= 4; i++) {
    const value = minimumY + (maximumY - minimumY) * i / 4;
    ctx.strokeStyle = '#3b4039'; ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(right, y(value)); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(id === 'spectrum' ? value.toFixed(0) : value.toFixed(2), left - 8, y(value));
  }
  const ticks = width < 400 ? 2 : 4;
  for (let i = 0; i <= ticks; i++) {
    const value = maximum * i / ticks;
    ctx.textAlign = i === ticks ? 'right' : i === 0 ? 'left' : 'center';
    ctx.fillText(value.toFixed(id === 'spectrum' ? 0 : 1), x(value), bottom + 18);
  }
  ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
  function trace(values, color, from = 0) {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash([]);
    for (let k = from; k <= last; k++) { if (k === from) ctx.moveTo(x(k * spacing), y(values[k])); else ctx.lineTo(x(k * spacing), y(values[k])); }
    ctx.stroke();
  }
  trace(data, '#a9c7c3', id === 'cepstrum' ? 1 : 0);
  if (id === 'spectrum') {
    trace(result.envelope, '#edcc77');
    for (const mark of markerSet(result.formants, prefs)) {
      if (mark.hz > maximum) continue;
      ctx.strokeStyle = colors[mark.kind]; ctx.lineWidth = mark.kind === 'center' ? 2 : 1;
      ctx.setLineDash(mark.kind === 'range' ? [7, 5] : mark.kind === 'bandwidth' ? [2, 4] : []);
      ctx.beginPath(); ctx.moveTo(x(mark.hz), top); ctx.lineTo(x(mark.hz), bottom); ctx.stroke();
    }
  }
  if (prefs.hover && inspection?.id === id) {
    ctx.setLineDash([3, 3]); ctx.strokeStyle = '#eeecdf'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(view.fraction * maximum), top); ctx.lineTo(x(view.fraction * maximum), bottom); ctx.stroke();
  }
  ctx.restore(); ctx.setLineDash([]);
  if (id === 'spectrum') {
    // Center names have reserved space above the plotting region.
    if (prefs.centers) for (const f of result.formants) if (f.center !== null && f.center <= maximum) {
      ctx.fillStyle = colors.center; ctx.textAlign = 'center'; ctx.fillText(f.id, x(f.center), 12);
    }
    if (prefs.notes || prefs.octaves) {
      // Thin musical-coordinate ticks to avoid overlap on narrow/linear axes.
      // Octaves alone use C boundaries; notes can label other semitones too.
      let previousX = -Infinity;
      for (let midi = 12; midi <= 120; midi++) {
        if (!prefs.notes && midi % 12 !== 0) continue;
        const frequency = prefs.reference * 2 ** ((midi - 69) / 12);
        if (frequency < 100 || frequency > maximum) continue;
        const label = musicalLabel(frequency, prefs.reference);
        const text = `${prefs.notes ? label.note : ''}${prefs.octaves ? (prefs.notes ? label.octave : `oct ${label.octave}`) : ''}`;
        const at = x(frequency), half = ctx.measureText(text).width / 2;
        if (at - previousX < 55 || at - half < left || at + half > right) continue;
        previousX = at;
        ctx.fillStyle = '#b7bbad'; ctx.textAlign = 'center'; ctx.fillText(text, at, bottom + 39);
      }
    }
  }
}

function renderReadout() {
  const container = document.getElementById('formants'); container.replaceChildren();
  for (const f of result.formants) {
    const row = document.createElement('button'); row.type = 'button'; row.setAttribute('aria-pressed', String(selected === f.id));
    const title = document.createElement('strong'); title.textContent = f.id; row.append(title);
    const values = [];
    if (prefs.centers) values.push(`Center: ${hz(f.center)}`);
    if (prefs.ranges) values.push(`Search: ${hz(f.bottom)} – ${hz(f.top)}`);
    if (prefs.bandwidth) values.push(`−3 dB: ${hz(f.lower)} – ${hz(f.upper)}`);
    values.push(f.status);
    for (const text of values) { const span = document.createElement('span'); span.textContent = text; row.append(span); }
    row.addEventListener('click', () => { selected = f.id; renderReadout(); renderInspection(); });
    container.append(row);
  }
}

function renderInspection() {
  info.replaceChildren();
  if (!prefs.hover) { info.textContent = 'Inspection disabled.'; return; }
  if (!inspection) { info.textContent = 'Hover, touch, or focus a plot and use ← / → to inspect.'; return; }
  const view = views.find(v => v.id === inspection.id), g = view.geometry;
  if (!g) return;
  const index = Math.min(g.last, Math.max(view.id === 'cepstrum' ? 1 : 0, Math.round(view.fraction * g.maximum / g.spacing)));
  const position = index * g.spacing, f = result.formants.find(f => f.id === selected);
  function detail(label, value) {
    const item = document.createElement('span'); item.className = 'detail';
    const title = document.createElement('strong'); title.textContent = `${label}: `; item.append(title, document.createTextNode(value)); info.append(item);
  }
  const field = prefs.fields;
  if (field.position) detail(view.id === 'spectrum' ? 'Frequency' : 'Quefrency', `${position.toFixed(2)} ${view.id === 'spectrum' ? 'Hz' : 'ms'}`);
  if (field.value) detail(view.id === 'spectrum' ? 'Power density' : 'Coefficient', view.id === 'spectrum' ? `${result.db[index].toFixed(2)} dB re 1 amplitude²/Hz` : result.cepstrum[index].toFixed(5));
  if (field.time) detail('Frame', `${Math.floor(result.start / 256)} · ${result.time.toFixed(3)} s (center)`);
  // Arbitrary cepstral cursor locations are not automatically pitch periods.
  if (field.music && view.id === 'spectrum') {
    const note = musicalLabel(position, prefs.reference);
    if (note) detail('Musical coordinate', `${note.note}${note.octave} · ${note.cents >= 0 ? '+' : ''}${note.cents.toFixed(1)} cents · A4 ${prefs.reference} Hz`);
  }
  if (field.formant) detail(`${f.id} linked frequency estimate`, `center ${hz(f.center)}; search ${hz(f.bottom)} – ${hz(f.top)}; −3 dB ${hz(f.lower)} – ${hz(f.upper)}`);
  if (field.evidence) detail('Evidence', `${f.status}${f.prominence === null ? '' : ` · ${f.prominence.toFixed(1)} dB above band median (contrast, not SNR)`}`);
  if (field.settings) detail('Analysis', `N=${result.size}, ${sampleRate} Hz, Hamming, hop 256; natural-log magnitude real cepstrum, symmetric 2 ms lifter`);
  if (!info.childNodes.length) info.textContent = 'No inspection fields selected for this view.';
}

function render() { if (!result) return; views.forEach(draw); renderReadout(); renderInspection(); }
for (const view of views) {
  function inspect(fraction) {
    if (!prefs.hover) return;
    view.fraction = Math.max(0, Math.min(1, fraction)); inspection = { id: view.id };
    views.forEach(draw); renderInspection();
  }
  view.canvas.addEventListener('pointermove', event => {
    const g = view.geometry; if (!g) return;
    const x = event.clientX - view.canvas.getBoundingClientRect().left;
    inspect((x - g.left) / (g.right - g.left));
  });
  view.canvas.addEventListener('pointerdown', event => {
    const g = view.geometry; if (!g) return;
    inspect((event.clientX - view.canvas.getBoundingClientRect().left - g.left) / (g.right - g.left));
  });
  view.canvas.addEventListener('focus', () => inspect(view.fraction));
  view.canvas.addEventListener('keydown', event => {
    const g = view.geometry; if (!g || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const delta = g.spacing / g.maximum * (event.shiftKey ? 10 : 1);
    inspect(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : view.fraction + (event.key === 'ArrowRight' ? delta : -delta));
  });
  new ResizeObserver(() => { if (result) { draw(view); renderInspection(); } }).observe(view.canvas);
}
setSource(syntheticVowel(), 16000, 'Synthetic /a/-like signal');
