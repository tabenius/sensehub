export const SHAPES = ['sine','square','saw','triangle','noise'];
export function noteHz(note, reference = 440) { return reference * 2 ** ((note - 69) / 12); }
export function decodeMidi(bytes, sourceId = 'virtual-midi') {
  const b = Array.from(bytes);
  if (!b.length || b.some(v => !Number.isInteger(v) || v < 0 || v > 255) || b[0] < 0x80 || b[0] >= 0xf0) return null;
  const command = b[0] >> 4, channel = (b[0] & 15) + 1;
  if (b.length < 3 || b[1] > 127 || b[2] > 127) return null;
  if (command === 8 || command === 9) return { source:'midi', sourceId, channel, kind:'note', number:b[1], value:command === 8 ? 0 : b[2], max:127, bytes:b };
  if (command === 11) return { source:'midi', sourceId, channel, kind:'cc', number:b[1], value:b[2], max:127, bytes:b };
  if (command === 14) return { source:'midi', sourceId, channel, kind:'pitchbend', number:null, value:b[1] | b[2] << 7, max:16383, bytes:b };
  return null;
}
export function validateBinding(binding) {
  if (!binding || typeof binding.id !== 'string' || !binding.id || !['midi','gpio','virtual'].includes(binding.source)) throw new Error('Binding requires an id and source.');
  if (!['cc','note','pitchbend','digital','value'].includes(binding.kind)) throw new Error('Unknown source event.');
  if (binding.source === 'midi' && !['cc','note','pitchbend'].includes(binding.kind) || binding.source === 'gpio' && binding.kind !== 'digital') throw new Error('Event kind does not match the source.');
  if (binding.channel !== null && (!Number.isInteger(binding.channel) || binding.channel < (binding.source === 'midi' ? 1 : 0) || binding.channel > (binding.source === 'midi' ? 16 : 255))) throw new Error('Invalid source channel.');
  if (binding.number !== null && (!Number.isInteger(binding.number) || binding.number < 0 || binding.number > 127)) throw new Error('Invalid note/CC number.');
  if (!['float','binary','integer','event'].includes(binding.output)) throw new Error('Unknown output representation.');
  if (!['absolute','twos-complement','sign-bit'].includes(binding.mode)) throw new Error('Unknown encoder mode.');
  if (binding.mode !== 'absolute' && binding.kind !== 'cc') throw new Error('Relative encoders require a MIDI CC event.');
  if (binding.mode !== 'absolute' && binding.output !== 'float') throw new Error('Encoder mode applies to Float outputs.');
  if (binding.range !== null && (!Array.isArray(binding.range) || binding.range.length !== 2 || !binding.range.every(Number.isFinite) || binding.range[0] >= binding.range[1])) throw new Error('Invalid output range.');
  if (!Number.isFinite(binding.scale) || !Number.isFinite(binding.offset)) throw new Error('Scale and offset must be finite.');
  if (binding.curve === 'log' && (!binding.range || binding.range[0] <= 0)) throw new Error('Log mapping needs a positive range.');
  if (!['linear','log'].includes(binding.curve) || !['momentary','toggle'].includes(binding.behavior)) throw new Error('Unknown mapping curve/behavior.');
  if (binding.binaryRule!==undefined&&!['half','nonzero'].includes(binding.binaryRule)) throw new Error('Unknown binary conversion.');
  if (!['keyboard','channel'].includes(binding.target) && !/^[ABCD]\.(frequency|amplitude|phase|duty|gate)$/.test(binding.target)) throw new Error('Unknown target parameter.');
  if (binding.target === 'keyboard' && (binding.output !== 'event' || binding.kind !== 'note')) throw new Error('Keyboard target requires structured note events.');
  if (binding.target !== 'keyboard' && binding.target !== 'channel' && binding.output === 'event') throw new Error('Scalar parameter targets require scalar outputs.');
  return binding;
}
export function matches(binding, event) {
  return binding.source === event.source && (!binding.sourceId || binding.sourceId === event.sourceId) && binding.kind === event.kind
    && (binding.channel === null || binding.channel === event.channel) && (binding.number === null || binding.number === event.number);
}
export function mapEvent(binding, event, previous = 0, wasActive = false) {
  validateBinding(binding);
  if (!matches(binding, event) || event.value === null) return null;
  if (binding.output === 'event') return { ...event };
  const active = event.kind === 'note' || binding.binaryRule==='nonzero' ? event.value > 0 : event.value >= event.max / 2;
  if (binding.output === 'binary') return binding.behavior === 'toggle' ? (active && !wasActive ? Number(!previous) : Number(Boolean(previous))) : Number(active);
  if (binding.output === 'integer') return event.value;
  if (binding.mode !== 'absolute') {
    const delta = binding.mode === 'twos-complement' ? (event.value >= 64 ? event.value - 128 : event.value) : (event.value & 64 ? -(event.value & 63) : event.value & 63);
    const value = previous + delta * binding.scale;
    return binding.range ? Math.max(binding.range[0], Math.min(binding.range[1], value)) : value;
  }
  if (!binding.range) return event.value * binding.scale + binding.offset;
  const fraction = event.value / event.max, [low, high] = binding.range;
  return binding.curve === 'log' ? low * (high / low) ** fraction : low + fraction * (high - low);
}

export class OscillatorBank {
  constructor() {
    this.oscillators = [
      {id:'A',shape:'sine',frequency:440,amplitude:0.5,phase:0,duty:0.5,enabled:true,gate:true},
      {id:'B',shape:'square',frequency:12,amplitude:0.25,phase:0,duty:0.5,enabled:false,gate:true},
      {id:'C',shape:'triangle',frequency:60,amplitude:0.2,phase:0,duty:0.5,enabled:false,gate:true},
      {id:'D',shape:'noise',frequency:1,amplitude:0.05,phase:0,duty:0.5,enabled:false,gate:true},
    ];
    this.phases = [0,0,0,0]; this.seed = 0xC0FFEE; this.sampleCount = 0;
  }
  set(id, parameter, value) {
    const oscillator = this.oscillators.find(o => o.id === id); if (!oscillator) throw new Error('Unknown oscillator.');
    if (['enabled','gate'].includes(parameter)) oscillator[parameter] = Boolean(value);
    else if (parameter === 'shape') { if (!SHAPES.includes(value)) throw new Error('Unknown waveform.'); oscillator.shape = value; }
    else {
      const limits = {frequency:[1,7000],amplitude:[0,1],phase:[0,1],duty:[0.01,0.99]};
      if (!limits[parameter] || !Number.isFinite(value)) throw new Error('Invalid oscillator parameter.');
      oscillator[parameter] = Math.max(limits[parameter][0], Math.min(limits[parameter][1], value));
    }
    return oscillator[parameter];
  }
  render(count = 2048, sampleRate = 16000) {
    if (!Number.isInteger(count) || count < 1 || count > 100000 || !(sampleRate > 14000)) throw new Error('Invalid virtual capture size/rate.');
    const mix = new Float64Array(count), traces = this.oscillators.map(() => new Float64Array(count));
    for (let i = 0; i < count; i++) this.oscillators.forEach((o, j) => {
      let value = 0; const p = (this.phases[j] + o.phase) % 1;
      if (o.shape === 'sine') value = Math.sin(2 * Math.PI * p);
      else if (o.shape === 'square') value = p < o.duty ? 1 : -1;
      else if (o.shape === 'saw') value = 2 * p - 1;
      else if (o.shape === 'triangle') value = 1 - 4 * Math.abs(p - 0.5);
      else { this.seed ^= this.seed << 13; this.seed ^= this.seed >>> 17; this.seed ^= this.seed << 5; value = (this.seed >>> 0) / 4294967295 * 2 - 1; }
      traces[j][i] = o.enabled && o.gate ? value * o.amplitude : 0; mix[i] += traces[j][i];
      this.phases[j] = (this.phases[j] + o.frequency / sampleRate) % 1;
    });
    const startSample = this.sampleCount; this.sampleCount += count;
    return { mix, traces, sampleRate, startSample };
  }
}

export function defaultBinding(id, options = {}) {
  return validateBinding({ id, source:'midi', sourceId:null, kind:'cc', channel:1, number:1,
    output:'float', mode:'absolute', range:[20,4000], scale:1, offset:0, curve:'log', behavior:'momentary', binaryRule:'half', target:'A.frequency', ...options });
}
export function validateControlMap(value) {
  if (value?.kind !== 'sensehub-controls' || value.version !== 1 || !Array.isArray(value.bindings) || value.bindings.length > 200) throw new Error('Invalid control map.');
  const checked = value.bindings.map(validateBinding);
  if (new Set(checked.map(b => b.id)).size !== checked.length) throw new Error('Duplicate binding IDs.');
  if (value.custom) {
    const c = value.custom;
    if (typeof c.name !== 'string' || c.name.length > 80 || !Array.isArray(c.controls) || !c.controls.length || c.controls.length > 32 || c.controls.some(control =>
      typeof control.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(control.id) || typeof control.label !== 'string' || control.label.length > 80 ||
      !['knob','slider','button','toggle','key'].includes(control.type) || !Number.isFinite(control.x) || !Number.isFinite(control.y) || control.x < 30 || control.x > 950 || control.y < 60 || control.y > 2000 ||
      control.type === 'key' && control.note !== undefined && (!Number.isInteger(control.note) || control.note < 0 || control.note > 127))) throw new Error('Invalid custom drawing.');
    if (new Set(c.controls.map(control => control.id)).size !== c.controls.length) throw new Error('Duplicate visual control IDs.');
    for (const control of c.controls) {
      for (const field of ['radius','width','height']) if (control[field] !== undefined && (!Number.isFinite(control[field]) || control[field] < 10 || control[field] > 180)) throw new Error('Invalid visual control size.');
      defaultBinding('validate-control', {source:'virtual',kind:control.type==='key'?'note':'value',channel:0,number:null,output:control.type==='key'?'event':'float',range:null,curve:'linear',target:control.target??'channel'});
    }
    if (c.image && (typeof c.image !== 'string' || c.image.length > 4100000 || !/^data:image\/(png|jpeg|webp);base64,/.test(c.image))) throw new Error('Invalid photo.');
  }
  if(value.presentation){const p=value.presentation;if(p.profile!==undefined&&!['hercules','umx','gpio','custom'].includes(p.profile)||p.zoom!==undefined&&(!Number.isFinite(p.zoom)||p.zoom<1||p.zoom>3)||p.hoverHints!==undefined&&typeof p.hoverHints!=='boolean')throw new Error('Invalid presentation preferences.');}
  return value;
}
