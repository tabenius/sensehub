// Typed, timestamped channel adapter. Time is integer microseconds, not bit index.
export const MAX_POINTS = 100000;
const stageNames = ['raw', 'conditioned', 'detected', 'decoded'];
const finiteTime = t => Number.isSafeInteger(t) && t >= 0;
function level(value, numeric) {
  if (value === null || value === '?') return null;
  if (numeric) { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Numeric samples must be finite numbers or null.'); return value; }
  if (value === 0 || value === '0' || value === false || value === 'LOW') return 0;
  if (value === 1 || value === '1' || value === true || value === 'HIGH') return 1;
  throw new Error('Digital values must be 0/1, HIGH/LOW, booleans, or ?/null for unknown.');
}

export function parseChannel(text, { name = 'Digital channel', intervalUs = 1000, numeric = false, stage = 'raw' } = {}) {
  if (!finiteTime(intervalUs) || intervalUs < 1) throw new Error('Sample interval must be a positive integer in microseconds.');
  if (!stageNames.includes(stage)) throw new Error('Unknown processing stage.');
  let payload = text.trim(), values, points, endUs, encoding = 'samples', provenance = null, unit = null;
  if (!payload) throw new Error('Enter signal data first.');
  if (payload.startsWith('[') || payload.startsWith('{')) payload = JSON.parse(payload);
  if (payload && !Array.isArray(payload) && typeof payload === 'object') {
    if (payload.schemaVersion !== 1 || !payload.data) throw new Error('Channel envelopes require schemaVersion: 1 and data.');
    name = payload.name ?? name; stage = payload.stage ?? stage;
    unit = payload.unit ?? null;
    if (unit !== null && (typeof unit !== 'string' || unit.length > 32)) throw new Error('Unit must be a short string.');
    if (payload.provenance && typeof payload.provenance === 'object' && !Array.isArray(payload.provenance)) provenance = structuredClone(payload.provenance);
    if (!stageNames.includes(stage)) throw new Error('Unknown processing stage.');
    numeric = payload.kind === 'numeric';
    if (!['digital', 'numeric'].includes(payload.kind)) throw new Error('This adapter accepts digital or numeric channels.');
    const data = payload.data;
    encoding = data.encoding;
    if (!['bits', 'samples', 'edges'].includes(encoding)) throw new Error('Unsupported channel encoding.');
    if (encoding === 'edges') {
      points = data.points; endUs = data.endUs;
    } else {
      intervalUs = data.intervalUs;
      if (!finiteTime(intervalUs) || intervalUs < 1) throw new Error('Invalid sample interval.');
      values = data.values;
      if (encoding === 'bits') {
        if (numeric || typeof values !== 'string' || !/^[01?]+$/.test(values)) throw new Error('bits encoding requires a digital 0/1/? string.');
        values = [...values];
      }
    }
  } else if (typeof payload === 'string') {
    if (numeric) values = payload.split(/[\s,]+/).map(v => v === '?' ? null : Number(v));
    else { const clean = payload.replace(/\s/g, ''); if (!/^[01?]+$/.test(clean)) throw new Error('Use a bit string, a JSON value array, or a channel envelope.'); values = [...clean]; encoding = 'bits'; }
  } else if (Array.isArray(payload)) {
    if (payload[0] && typeof payload[0] === 'object') { points = payload; endUs = points.at(-1)?.tUs + intervalUs; encoding = 'edges'; }
    else values = payload;
  }
  if (values) {
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_POINTS) throw new Error(`Provide 1–${MAX_POINTS} samples.`);
    points = values.map((value, i) => ({ tUs: i * intervalUs, value: level(value, numeric) }));
    endUs = values.length * intervalUs;
  } else {
    if (!Array.isArray(points) || points.length === 0 || points.length > MAX_POINTS) throw new Error(`Provide 1–${MAX_POINTS} timestamped points.`);
    points = points.map(p => ({ tUs: p.tUs, value: level(p.value, numeric) }));
  }
  if (!finiteTime(endUs) || endUs <= points.at(-1).tUs) throw new Error('endUs must extend past the last observation.');
  let previous = -1;
  for (const p of points) {
    if (!finiteTime(p.tUs) || p.tUs <= previous) throw new Error('Timestamps must be strictly increasing safe integer microseconds.');
    previous = p.tUs;
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Use a channel name of 1–80 characters.');
  return { name, kind: numeric ? 'numeric' : 'digital', stage, encoding, points, endUs, intervalUs, provenance, unit };
}

export function compact(points) {
  return points.filter((p, i) => i === 0 || p.value !== points[i - 1].value).map(p => ({ ...p }));
}

// Offline sample-and-hold semantics. Unknown intervals break debounce continuity.
export function debounce(points, endUs, holdUs) {
  if (!finiteTime(holdUs)) throw new Error('Debounce must be nonnegative integer microseconds.');
  if (!holdUs) return compact(points);
  const output = [];
  let stable = null;
  function emit(tUs, value) { if (!output.length || output.at(-1).value !== value) output.push({ tUs, value }); }
  for (let i = 0; i < points.length; i++) {
    const p = points[i], next = points[i + 1]?.tUs ?? endUs;
    if (p.value === null) { stable = null; emit(p.tUs, null); continue; }
    if (p.value === stable) continue;
    let limit = next, j = i + 1;
    while (j < points.length && points[j].value === p.value) { limit = points[j + 1]?.tUs ?? endUs; j++; }
    if (stable === null) emit(p.tUs, null);
    const due = p.tUs + holdUs;
    if (due < limit || (due === limit && j < points.length && points[j].value !== null)) { stable = p.value; emit(due, stable); }
    i = j - 1;
  }
  return output;
}

export function processChannel(channel, options = {}) {
  const { invert = false, debounceUs = 0, low = 0.3, high = 0.7, emaAlpha = 1, median = false, output = 'digital' } = options;
  if (!['digital','numeric'].includes(output) || output === 'numeric' && channel.kind !== 'numeric') throw new Error('Numeric output requires a numeric source.');
  if (output === 'numeric' && (invert || debounceUs)) throw new Error('Polarity inversion and stable-time debounce apply to logic output.');
  if (!(emaAlpha > 0 && emaAlpha <= 1)) throw new Error('EMA alpha must be in (0,1].');
  if (channel.kind === 'numeric' && output === 'digital' && (!Number.isFinite(low) || !Number.isFinite(high) || low >= high)) throw new Error('LOW threshold must be below HIGH threshold.');
  let smoothed = null, stable = null, history = [];
  const conditioned = channel.points.map(p => {
    if (p.value === null) { smoothed = null; stable = null; history = []; return { ...p }; }
    let value = p.value;
    if (channel.kind === 'numeric') {
      history.push(value); if (history.length > 3) history.shift();
      if (median) value = [...history].sort((a, b) => a - b)[Math.floor(history.length / 2)];
      smoothed = smoothed === null ? value : smoothed + emaAlpha * (value - smoothed);
      if (output === 'numeric') return { tUs:p.tUs, value:smoothed };
      if (smoothed <= low) stable = 0; else if (smoothed >= high) stable = 1;
      value = stable;
    }
    return { tUs: p.tUs, value: value === null ? null : invert ? 1 - value : value };
  });
  if (output === 'numeric') return { ...channel, points:conditioned, stage:median || emaAlpha !== 1 ? 'conditioned' : channel.stage,
    pipeline:{ invert, debounceUs, low, high, emaAlpha, median, output },sourceStage:channel.stage };
  const points = debounce(conditioned, channel.endUs, debounceUs);
  return { ...channel, kind: 'digital', stage: channel.kind === 'numeric' ? 'detected' : (invert || debounceUs ? 'conditioned' : channel.stage),
    unit: 'logic', points, pipeline: { invert, debounceUs, low, high, emaAlpha, median, output }, sourceStage: channel.stage };
}

export function channelStats(channel) {
  let highUs = 0, knownUs = 0, rising = 0, falling = 0, previous = null;
  channel.points.forEach((p, i) => {
    const duration = (channel.points[i + 1]?.tUs ?? channel.endUs) - p.tUs;
    if (p.value !== null) { knownUs += duration; if (p.value === 1) highUs += duration; }
    if (previous === 0 && p.value === 1) rising++;
    if (previous === 1 && p.value === 0) falling++;
    previous = p.value;
  });
  return { highUs, knownUs, rising, falling, duty: knownUs ? highUs / knownUs : null };
}

export function atTime(channel, tUs) {
  if (tUs < channel.points[0].tUs || tUs >= channel.endUs) return null;
  let lo = 0, hi = channel.points.length;
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (channel.points[mid].tUs <= tUs) lo = mid; else hi = mid; }
  return channel.points[lo].value;
}

export function exportChannel(channel) {
  return { schemaVersion: 1, name: channel.name, kind: channel.kind, stage: channel.stage, unit: channel.unit,
    provenance: { sourceStage: channel.sourceStage ?? channel.stage, pipeline: channel.pipeline ?? {}, algorithm: 'sensehub-condition-v1', clock: 'source-local-us', input: channel.provenance ?? null },
    data: { encoding: 'edges', points: compact(channel.points), endUs: channel.endUs } };
}
