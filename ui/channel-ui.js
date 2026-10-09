import { parseChannel, processChannel, channelStats, atTime, exportChannel, compact } from './channels.js';
import { AI_THINKER_PREVIEW, normalizeCapabilities, validateDeviceRequest } from './capabilities.js';
import { validId, validateSession, validateScript, validateProcessing, sourceEnvelope } from './session.js';

const channels = new Map(); let sequence = 0;
const container = document.getElementById('channel-list');
const message = document.getElementById('channel-message');
const get = id => document.getElementById(id);
let capabilities = normalizeCapabilities(AI_THINKER_PREVIEW);
function label(text, input) { const element = document.createElement('label'); element.append(document.createTextNode(text), input); return element; }
function number(value, min, max, step = 1) { const input = document.createElement('input'); Object.assign(input, { type: 'number', value, min, max, step }); return input; }
function check(checked = false) { const input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked; return input; }
function button(text, action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.addEventListener('click', action); return b; }

function add(channel, options = {}) {
  if (channels.size >= 32) throw new Error('This prototype supports 32 display channels per session.');
  let id = options.id;
  if (!id) { do { id = `logic-${++sequence}`; } while (channels.has(id)); }
  if (!validId(id) || channels.has(id)) throw new Error('Channel ID must be unique.');
  const processing = validateProcessing(options.processing ?? {});
  const processed = processChannel(channel, processing);
  const state = { id, source: channel, processed, options: processed.pipeline, visible: options.visible !== false, raw: options.raw !== false, fromProxy:options.fromProxy===true, fraction: 0, error: '' };
  channels.set(id, state); makeCard(state); redrawAll();
  markChanged(state);
  message.textContent = `Added ${channel.name}. ${channels.size} channels in this session.`;
  return id;
}
get('add-channel').addEventListener('submit', event => {
  event.preventDefault();
  try {
    add(parseChannel(get('channel-data').value, { name: get('channel-name').value, intervalUs: Number(get('channel-interval').value), numeric: get('channel-kind').value === 'numeric', stage: get('channel-stage').value }));
    get('channel-name').value = `Logic ${sequence + 1}`;
  } catch (error) { message.textContent = error.message; }
});
get('channel-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try { if (file.size > 5000000) throw new Error('Channel files must be smaller than 5 MB.'); add(parseChannel(await file.text())); }
  catch (error) { message.textContent = error.message; }
});
get('channel-demo').addEventListener('click', () => {
  try {
    add(parseChannel('0000010101111111100000111110000', { name: 'Contact bounce', intervalUs: 1000 }));
    add(parseChannel('[0.1,0.15,0.9,0.18,0.2,0.35,0.6,0.8,0.65,0.75,0.9,0.5,0.4,0.2,null,0.1,0.9,0.85]', { name: 'Optical receiver', intervalUs: 2000, numeric: true }));
  } catch (error) { message.textContent = error.message; }
});

function makeCard(state) {
  const card = document.createElement('article'); card.className = 'channel-card'; card.dataset.channel = state.id;
  const header = document.createElement('div'); header.className = 'channel-card-header';
  const title = document.createElement('h3'); title.textContent = `${state.source.name} · ${state.id}`;
  const visible = check(state.visible), raw = check(state.raw);
  visible.addEventListener('change', () => { state.visible = visible.checked; state.canvas.hidden = !state.visible; redrawAll(); });
  raw.addEventListener('change', () => { state.raw = raw.checked; draw(state); });
  header.append(title, label('Show trace ', visible), label('Show original ', raw), button('Export processed', () => {
    const blob = new Blob([JSON.stringify(exportChannel(state.processed), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = `${state.id}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }), button('Remove', () => remove(state.id)));
  const meta = document.createElement('p'); meta.className = 'channel-meta';
  const canvas = document.createElement('canvas'); canvas.tabIndex = 0; canvas.setAttribute('aria-label', `${state.source.name}, digital timeline. Arrow keys inspect samples.`);
  const inspection = document.createElement('p'); inspection.className = 'channel-inspect'; inspection.textContent = 'Hover, touch or use arrow keys to inspect HIGH / LOW / unknown.';
  const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Condition / detect · advanced'; details.append(summary);
  const legend = document.createElement('p'); legend.className = 'caption'; legend.textContent = 'Blue dashed: original observations · orange: derived HIGH/LOW · gray: unknown / not recorded. Numeric originals have their own scale.';
  const controls = document.createElement('div'); controls.className = 'processing';
  const invert = check(), debounce = number(0, 0, 60000), low = number(0.3, -1e9, 1e9, 0.01), high = number(0.7, -1e9, 1e9, 0.01), ema = number(1, 0.001, 1, 0.05), median = check();
  const output=document.createElement('select');output.append(new Option('Digital detector','digital'),new Option('Numeric monitor / filter','numeric'));
  if(state.source.kind==='numeric')controls.append(label('Output representation',output));
  const showProcessingFields=()=>{const numeric=state.source.kind==='numeric'&&output.value==='numeric';for(const input of [invert,debounce,low,high]){const parent=input.closest('label');if(parent)parent.hidden=numeric;}};
  output.addEventListener('change',showProcessingFields);
  controls.append(label('Invert polarity ', invert), label('Stable-time debounce (ms)', debounce));
  if (state.source.kind === 'numeric') controls.append(label('LOW at / below', low), label('HIGH at / above', high), label('EMA α per observation', ema), label('Causal median of last 3 ', median));
  controls.append(button('Apply to derived trace', () => {
    try {
      if ([debounce, ...(state.source.kind === 'numeric' ? [low, high, ema] : [])].some(input => !input.validity.valid)) throw new Error('Check the processing parameter ranges.');
      const numeric=state.source.kind==='numeric'&&output.value==='numeric';
      applyProcessing(state.id, { invert: numeric?false:invert.checked, debounceUs: numeric?0:Math.round(Number(debounce.value) * 1000), low: Number(low.value), high: Number(high.value), emaAlpha: Number(ema.value), median: median.checked, output:numeric?'numeric':'digital' });
    } catch (error) { state.error = error.message; updateMeta(state); }
  }));
  const explanation = document.createElement('p'); explanation.className = 'caption'; explanation.textContent = 'Order: numeric median → EMA → LOW/HIGH hysteresis → inversion → stable-time debounce. Unknown intervals reset filter state. Imported timing is sample-and-hold; preprocessing adds latency. Edges and duty summarize the derived trace, not the original source.';
  details.append(controls, explanation); card.append(header, meta, canvas, legend, inspection, details); container.append(card);
  Object.assign(state, { card, canvas, meta, inspection, controls: { invert, debounce, low, high, ema, median, visible, raw, output }, showProcessingFields, legend, explanation });
  syncControls(state); canvas.hidden = !state.visible;
  function inspect(fraction) { state.fraction = Math.max(0, Math.min(1, fraction)); draw(state); }
  for (const name of ['pointermove', 'pointerdown']) canvas.addEventListener(name, event => {
    const width = canvas.getBoundingClientRect().width; inspect((event.clientX - canvas.getBoundingClientRect().left - 58) / (width - 70));
  });
  canvas.addEventListener('focus', () => draw(state));
  canvas.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const step = state.source.intervalUs / timelineWindow().span * (event.shiftKey ? 10 : 1);
    inspect(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : state.fraction + (event.key === 'ArrowRight' ? step : -step));
  });
  state.observer = new ResizeObserver(() => draw(state)); state.observer.observe(canvas); updateMeta(state);
}

function updateMeta(state) {
  if(state.processed.kind==='numeric'){
    const known=state.processed.points.filter(p=>p.value!==null).map(p=>p.value);
    state.meta.textContent=state.error||`${state.source.stage} numeric → ${state.processed.stage} numeric · ${known.length} known observations · source-local clock`;
    state.legend.textContent='Blue dashed: original values · orange: numeric output · gray: unknown / not recorded. Each lane shows its scale.';
    state.explanation.textContent='Numeric output retains source units. Median and EMA are optional; thresholding and debounce are not applied. Unknown intervals reset filter state.';return;
  }
  const stats = channelStats(state.processed);
  state.legend.textContent='Blue dashed: original observations · orange: derived HIGH/LOW · gray: unknown / not recorded. Numeric originals have their own scale.';
  state.explanation.textContent='Order: numeric median → EMA → LOW/HIGH hysteresis → inversion → stable-time debounce. Unknown intervals reset filter state. Edges and duty summarize the derived logic trace.';
  state.meta.textContent = state.error || `${state.source.stage} ${state.source.kind} → ${state.processed.stage} digital · ${stats.rising} rising / ${stats.falling} falling · HIGH ${stats.duty === null ? 'unknown' : (stats.duty * 100).toFixed(1) + '%'} of known time · ${(stats.knownUs / state.source.endUs * 100).toFixed(1)}% coverage · source-local clock`;
}
function syncControls(state) {
  const c = state.controls, o = state.options;
  c.invert.checked = o.invert ?? false; c.debounce.value = (o.debounceUs ?? 0) / 1000;
  c.low.value = o.low ?? 0.3; c.high.value = o.high ?? 0.7; c.ema.value = o.emaAlpha ?? 1; c.median.checked = o.median ?? false;
  c.visible.checked = state.visible; c.raw.checked = state.raw;
  c.output.value=o.output??'digital';state.showProcessingFields();
}
function applyProcessing(id, options) {
  const state = channels.get(id); if (!state) throw new Error(`Unknown channel ${id}.`);
  validateProcessing(options); const derived = processChannel(state.source, options);
  state.options = structuredClone(derived.pipeline); state.processed = derived; state.error = '';
  syncControls(state); updateMeta(state); draw(state);
  markChanged(state);
}
function remove(id) {
  const state = channels.get(id); if (!state) throw new Error(`Unknown channel ${id}.`);
  state.observer.disconnect(); channels.delete(id); state.card.remove(); redrawAll();
  markChanged(state);
  document.dispatchEvent(new CustomEvent('sensehub:channel-removed',{detail:{id}}));
}
function maximumTime() { return Math.max(1, ...Array.from(channels.values(), c => c.source.endUs)); }
function timelineWindow() {
  const max = maximumTime(), span = Math.min(Number(get('time-window').value) || max, max);
  const start = Math.min(Number(get('time-start').value), max - span);
  return { start, end: start + span, span };
}
function redrawAll() {
  const { start, end, span } = timelineWindow();
  get('time-start').max = maximumTime() - span; get('time-start').step = Math.max(1, Math.round(span / 200));
  get('time-start').value = start; get('time-start').disabled = maximumTime() === span;
  get('time-view').textContent = `${(start / 1000).toFixed(1)}–${(end / 1000).toFixed(1)} ms · source-local clocks`;
  channels.forEach(draw);
}
for (const id of ['time-window', 'time-start']) get(id).addEventListener('input', redrawAll);
function draw(state) {
  if (!state.visible) return;
  const canvas = state.canvas, width = canvas.getBoundingClientRect().width, separateRaw = state.source.kind === 'numeric' && state.raw, height = separateRaw ? 185 : 145;
  if (!width) return;
  canvas.style.height = `${height}px`;
  const ratio = devicePixelRatio || 1; canvas.width = Math.round(width * ratio); canvas.height = height * ratio;
  const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const { start, end, span } = timelineWindow();
  const left = 58, right = width - 12, x = t => left + (t - start) / span * (right - left);
  ctx.font = '11px system-ui'; ctx.fillStyle = '#b7bbad'; ctx.textAlign = 'right';
  const primaryValues=state.processed.kind==='numeric'?state.processed.points.filter(p=>p.value!==null).map(p=>p.value):[0,1];
  ctx.fillText(state.processed.kind==='numeric'?primaryValues.reduce((m,v)=>Math.max(m,v),1).toPrecision(3):'HIGH',left-8,29);
  ctx.fillText(state.processed.kind==='numeric'?primaryValues.reduce((m,v)=>Math.min(m,v),0).toPrecision(3):'LOW',left-8,79);
  ctx.strokeStyle = '#3b4039';
  for (const y of [25, 75]) { ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); }
  ctx.save(); ctx.beginPath(); ctx.rect(left, 15, right - left, height - 45); ctx.clip();
  for (const [a, b] of [[start, Math.min(end, state.processed.points[0]?.tUs ?? end)], [Math.max(start, state.source.endUs), end]]) {
    if (b > a) { ctx.fillStyle = '#62685855'; ctx.fillRect(x(a), 20, x(b) - x(a), 60); }
  }
  function trace(channel, raw) {
    const points = compact(channel.points);
    const nums = channel.kind === 'numeric' ? points.filter(p => p.value !== null).map(p => p.value) : [0, 1];
    const min = nums.reduce((m, v) => Math.min(m, v), 0), peak = nums.reduce((m, v) => Math.max(m, v), 1), y = v => (raw && separateRaw ? 135 : 75) - (v - min) / (peak - min) * (raw && separateRaw ? 35 : 50);
    ctx.strokeStyle = raw ? '#9aadc9' : '#ffb366'; ctx.setLineDash(raw ? [3, 3] : []); ctx.lineWidth = raw ? 1 : 2;
    // Preserve transitions; dense sub-pixel pulses still need a closer time view.
    for (let i = 0; i < points.length; i++) {
      const p = points[i], next = points[i + 1]?.tUs ?? channel.endUs;
      if (next <= start || p.tUs >= end) continue;
      if (p.value === null) { if (!raw) { ctx.fillStyle = '#62685855'; ctx.fillRect(x(p.tUs), 20, Math.max(1, x(next) - x(p.tUs)), 60); } continue; }
      ctx.beginPath(); ctx.moveTo(x(p.tUs), y(p.value)); ctx.lineTo(x(next), y(p.value));
      if (points[i + 1]?.value !== null && points[i + 1]?.value !== undefined) ctx.lineTo(x(next), y(points[i + 1].value));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  if (state.raw) trace(state.source, true); trace(state.processed, false);
  ctx.restore();
  if (separateRaw) {
    const numeric = state.source.points.filter(p => p.value !== null).map(p => p.value);
    const min = numeric.reduce((m, v) => Math.min(m, v), 0), max = numeric.reduce((m, v) => Math.max(m, v), 1);
    ctx.fillStyle = '#9aadc9'; ctx.textAlign = 'right';
    ctx.fillText(max.toPrecision(3), left - 8, 100); ctx.fillText('RAW', left - 8, 117); ctx.fillText(min.toPrecision(3), left - 8, 137);
  }
  const ticks = width < 400 ? 2 : 4;
  for (let i = 0; i <= ticks; i++) { const time = start + i * span / ticks; ctx.fillStyle = '#b7bbad'; ctx.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center'; ctx.fillText(`${(time / 1000).toFixed(1)} ms`, x(time), height - 15); }
  const tUs = Math.min(end - 1, start + Math.round(state.fraction * span));
  ctx.strokeStyle = '#eeecdf'; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(x(tUs), 15); ctx.lineTo(x(tUs), 85); ctx.stroke();
  const value = atTime(state.processed, tUs), raw = atTime(state.source, tUs);
  state.inspection.textContent = `${(tUs / 1000).toFixed(3)} ms · derived ${value === null ? 'unknown' : state.processed.kind==='numeric'?value.toFixed(4):value ? 'HIGH' : 'LOW'} · source ${raw === null ? 'unknown' : raw}${state.source.unit ? ` ${state.source.unit}` : ''} · ${state.source.stage} → ${state.processed.stage}`;
}

function showCapabilities(value) {
  capabilities = normalizeCapabilities(value);
  get('device-capabilities').textContent = `${capabilities.profile} · ${capabilities.soc ?? 'SoC unspecified'} · available pins ${capabilities.availablePins.join(', ') || 'none configured'}. This is a configuration description, not a live connection.`;
  for (const option of get('device-mode').options) option.disabled = option.value !== 'disabled' && !capabilities.modes.includes(({ input: 'digital-input', output: 'digital-output', pwm: 'pwm-output' })[option.value]);
  if (get('device-mode').selectedOptions[0].disabled) get('device-mode').value = capabilities.modes.includes('digital-input') ? 'input' : 'disabled';
  get('device-channel').min = Math.min(...capabilities.channelIds, 255); get('device-channel').max = Math.max(...capabilities.channelIds, 0);
  get('device-channel').value = capabilities.channelIds[0] ?? 0;
  get('device-frequency').max = capabilities.pwmMaxHz ?? 1;
  updateDeviceFields();
}
function updateDeviceFields() {
  const mode = get('device-mode').value, previous = Number(get('device-pin').value);
  const pins = mode === 'input' ? capabilities.availablePins : capabilities.outputPins;
  get('device-pin').replaceChildren();
  for (const pin of pins) { const option = document.createElement('option'); option.value = pin; option.textContent = `GPIO ${pin}`; get('device-pin').append(option); }
  if (pins.includes(previous)) get('device-pin').value = previous;
  get('device-pin').disabled = mode === 'disabled';
  for (const id of ['device-pull', 'device-poll', 'device-debounce', 'device-invert', 'device-level', 'device-frequency', 'device-duty']) {
    const active = ['device-pull','device-poll','device-debounce','device-invert'].includes(id) ? mode === 'input' : id === 'device-level' ? mode === 'output' : mode === 'pwm';
    get(id).disabled = !active; get(id).closest('label').hidden = !active;
  }
}
get('device-mode').addEventListener('change', updateDeviceFields);
get('capabilities-preview').addEventListener('click', () => showCapabilities(AI_THINKER_PREVIEW));
get('capabilities-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try { if (file.size > 50000) throw new Error('Capability file is too large.'); showCapabilities(JSON.parse(await file.text())); }
  catch (error) { get('device-capabilities').textContent = error.message; }
});
get('device-config').addEventListener('submit', event => {
  event.preventDefault();
  try {
  const modes = { disabled: 0, input: 1, output: 2, pwm: 3 }, pulls = { none: 0, up: 1, down: 2 };
  const mode = modes[get('device-mode').value], id = Number(get('device-channel').value), pin = Number(get('device-pin').value);
  const poll = Number(get('device-poll').value), debounce = mode === 1 ? Number(get('device-debounce').value) : 0, invert = mode === 1 ? Number(get('device-invert').checked) : 0;
  const frequency = mode === 3 ? Number(get('device-frequency').value) : 0, duty = mode === 3 ? Math.round(Number(get('device-duty').value) / 100 * 1023) : 0;
  const pull = mode === 1 ? pulls[get('device-pull').value] : 0, output = mode === 2 ? Number(get('device-level').value) : 0;
  validateDeviceRequest({ id, mode: get('device-mode').value, pin, pull: get('device-pull').value, frequency }, capabilities);
  get('device-request').textContent = `USB: CHANNEL ${id} ${mode} ${pin} ${pull} ${invert} ${poll} ${debounce} ${output} ${frequency} ${duty}\n\nModes: 0 disabled, 1 digital input, 2 digital output, 3 PWM.\nPrepared only — no transport is connected. Device must validate pin/resource availability and return the applied configuration.`;
  } catch (error) { get('device-request').textContent = error.message; }
});
showCapabilities(AI_THINKER_PREVIEW);

function download(name, object) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(object, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function sessionObject() {
  return { kind: 'sensehub-session', version: 1, channels: Array.from(channels.values(), s => ({ id: s.id, source: sourceEnvelope(s.source), processing: s.options, visible: s.visible, raw: s.raw })) };
}
get('save-session').addEventListener('click', () => download('sensehub-session.json', sessionObject()));
function runScript(text) {
  const commands = validateScript(text, Array.from(channels.values())); const lines = [];
  for (const command of commands) {
    if (command.command === 'add') { add(command.source, { id: command.id }); lines.push(`Added ${command.id}.`); }
    else if (command.command === 'process') { applyProcessing(command.id, command.processing); lines.push(`Processed ${command.id}; source retained.`); }
    else if (command.command === 'remove') { remove(command.id); lines.push(`Removed ${command.id}.`); }
    else if (['show','hide'].includes(command.command)) {
      const state = channels.get(command.id); state.visible = command.command === 'show'; state.canvas.hidden = !state.visible; syncControls(state); redrawAll();
    } else if (command.command === 'list') lines.push(...Array.from(channels.values(), s => `${s.id} · ${s.source.name} · ${s.source.stage} → ${s.processed.stage}`));
    else if (command.command === 'help') lines.push('add <JSON channel with id>\nprocess <id> {"debounceUs":2000}\nshow <id> | hide <id> | remove <id> | list | help\nOpen .sensehub files to repeat a bench. No JavaScript is executed.');
  }
  get('console-output').textContent = lines.join('\n') || 'No commands to run.';
  return commands.length;
}
get('run-console').addEventListener('click', () => { try { runScript(get('console-input').value); } catch (error) { get('console-output').textContent = error.message; } });
function openConsole() { get('command-console').open = true; get('console-input').focus(); }
get('open-console').addEventListener('click', openConsole);
get('console-input').addEventListener('keydown', event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); get('run-console').click(); } });
document.addEventListener('keydown', event => {
  if (event.ctrlKey && event.key.toLowerCase() === 'k') { event.preventDefault(); openConsole(); }
  if (event.altKey && event.key.toLowerCase() === 'a') { event.preventDefault(); get('channel-name').focus(); }
});
get('session-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 8000000) throw new Error('Session/script file exceeds 8 MB.');
    const text = await file.text();
    if (file.name.endsWith('.sensehub')) { openConsole(); get('console-input').value = text; runScript(text); }
    else {
      const entries = validateSession(JSON.parse(text));
      if (channels.size + entries.length > 32 || entries.some(e => channels.has(e.id))) throw new Error('Session IDs conflict with existing channels, or exceed the limit. Existing channels were retained.');
      entries.forEach(entry => add(entry.source, entry));
      message.textContent = `Opened ${file.name}: ${entries.length} channels; existing channels retained.`;
    }
  } catch (error) { message.textContent = error.message; }
});

let subscription = null, livePublishTimer=null, proxyDirty=false, publishing=false;
function markChanged(state){if(!state.fromProxy)proxyDirty=true;}
const proxyIds = new Map();
get('proxy-url').value = location.port === '8902' ? 'http://127.0.0.1:8903' : location.origin;
function proxyBase() {
  const url = new URL(get('proxy-url').value);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) proxy URL.');
  return url.origin;
}
async function publishChannels(){
  if(publishing)return;publishing=true;
  try {
    const branch = get('proxy-branch').value;
    const outgoing = Array.from(channels.values()).filter(s => !s.fromProxy).map(s => ({ id: s.id,
      ...(branch !== 'processed' ? { raw: sourceEnvelope(s.source) } : {}), ...(branch !== 'raw' ? { processed: exportChannel(s.processed) } : {}) }));
    if (!outgoing.length) throw new Error('Add local channels to publish first. Subscribed channels are not automatically republished.');
    const response = await fetch(`${proxyBase()}/api/channels`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channels: outgoing }) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    get('proxy-status').textContent = `Published ${outgoing.length} channels (${branch}). API revision ${value.revision}. ${livePublishTimer?'Live forwarding active.':'Publish again to share subsequent edits.'}`;
  } catch (error) { get('proxy-status').textContent = error.message;stopLivePublish(); }
  finally{publishing=false;}
}
function stopLivePublish(){if(livePublishTimer)clearInterval(livePublishTimer);livePublishTimer=null;}
get('proxy-publish').addEventListener('click', async () => {
  stopLivePublish();proxyDirty=false;
  if(get('proxy-live').checked)livePublishTimer=setInterval(()=>{if(proxyDirty&&!publishing){proxyDirty=false;publishChannels();}},100);
  await publishChannels();
});
get('proxy-live').addEventListener('change',()=>{if(!get('proxy-live').checked)stopLivePublish();});
function ingestRecord(record) {
  for (const branch of ['raw','processed']) if (record[branch]) {
    const envelope = record[branch], key = `${record.id}:${branch}`;
    if (!proxyIds.has(key)) proxyIds.set(key, `subscription-${++sequence}-${branch}`);
    const id = proxyIds.get(key);
    const source = parseChannel(JSON.stringify({ ...envelope, name: `${envelope.name} / ${branch === 'raw' ? 'original' : 'processed'}` }));
    const existing = channels.get(id);
    if (existing) window.sensehubLab.upsertChannel(id,{...envelope,name:source.name});
    else add(source, { id, fromProxy:true, processing:source.kind==='numeric'?{output:'numeric'}:{} });
  }
}
get('proxy-subscribe').addEventListener('click', () => {
  try {
    subscription?.close(); subscription = new EventSource(`${proxyBase()}/api/events?branch=${get('proxy-branch').value}`);
    subscription.addEventListener('snapshot', event => {
      try {
        // A reconnect snapshot replaces subscribed state, avoiding stale channels
        // that disappeared while disconnected. Local channels are retained.
        for (const state of Array.from(channels.values())) if (state.fromProxy) remove(state.id);
        JSON.parse(event.data).channels.forEach(ingestRecord); get('proxy-status').textContent = 'Subscribed: current snapshot loaded; waiting for channel updates.';
      }
      catch (error) { get('proxy-status').textContent = error.message; }
    });
    subscription.addEventListener('channel', event => { try { ingestRecord(JSON.parse(event.data)); get('proxy-status').textContent = 'Subscribed: channel update received.'; } catch (error) { get('proxy-status').textContent = error.message; } });
    subscription.addEventListener('removed', event => { const id = JSON.parse(event.data).id; for (const branch of ['raw','processed']) { const localId = proxyIds.get(`${id}:${branch}`); if (channels.has(localId)) remove(localId); proxyIds.delete(`${id}:${branch}`); } });
    subscription.onerror = () => { get('proxy-status').textContent = 'Subscription interrupted; reconnecting will load a fresh snapshot. Check the proxy URL/server.'; };
  } catch (error) { get('proxy-status').textContent = error.message; }
});
get('proxy-disconnect').addEventListener('click', () => { subscription?.close(); subscription = null;stopLivePublish(); get('proxy-status').textContent = 'Disconnected. Imported snapshots retained.'; });
window.addEventListener('pagehide', () => {subscription?.close();stopLivePublish();});
for (const fileLabel of document.querySelectorAll('.file')) {
  fileLabel.tabIndex = 0; fileLabel.setAttribute('role', 'button');
  fileLabel.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileLabel.querySelector('input[type=file]').click(); } });
}

// Transport-neutral entry point for future adapters and embedding. No hidden network connection.
window.sensehubLab = Object.freeze({
  receiveChannel: envelope => add(parseChannel(JSON.stringify(envelope))),
  receiveCapabilities: showCapabilities,
  channels: () => Array.from(channels.values(), c => exportChannel(c.processed)),
  session: sessionObject,
  runScript,
  upsertChannel: (id, envelope, options = {}) => {
    if (!validId(id)) throw new Error('Invalid channel id.');
    const source = parseChannel(JSON.stringify(envelope)), state = channels.get(id);
    if (state) {
      const changed=state.source.kind!==source.kind, processing=options.processing??(changed?{output:source.kind==='numeric'?'numeric':'digital'}:state.options), derived=processChannel(source,processing);
      if(changed){state.observer.disconnect();state.card.remove();}
      state.source=source;state.processed=derived;state.options=derived.pipeline;
      if(changed)makeCard(state);else updateMeta(state);redrawAll();
      markChanged(state);
    }
    else add(source, { id, processing:options.processing??(source.kind==='numeric'?{output:'numeric'}:{}) });
    return id;
  },
});
