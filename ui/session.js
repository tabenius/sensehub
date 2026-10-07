import { parseChannel, processChannel } from './channels.js';
export const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
export function validateProcessing(options = {}) {
  const known = ['invert','debounceUs','low','high','emaAlpha','median'];
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !known.includes(k))) throw new Error('Unknown processing option.');
  for (const key of ['invert','median']) if (key in options && typeof options[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
  return options;
}
export function sourceEnvelope(channel) {
  return { schemaVersion: 1, name: channel.name, kind: channel.kind, stage: channel.stage, unit: channel.unit,
    provenance: { clock: 'source-local-us', encoding: channel.encoding, intervalUs: channel.intervalUs, input: channel.provenance },
    data: { encoding: 'edges', points: channel.points.map(p => ({ ...p })), endUs: channel.endUs } };
}
export function validateSession(value) {
  if (value?.kind !== 'sensehub-session' || value.version !== 1 || !Array.isArray(value.channels) || value.channels.length > 32) throw new Error('Use a version 1 SenseHub session with up to 32 channels.');
  const ids = new Set();
  return value.channels.map(entry => {
    if (!validId(entry.id) || ids.has(entry.id)) throw new Error('Session channel IDs must be unique identifiers.');
    ids.add(entry.id);
    const source = parseChannel(JSON.stringify(entry.source)), processing = validateProcessing(entry.processing ?? {});
    processChannel(source, processing);
    return { id: entry.id, source, processing, visible: entry.visible !== false, raw: entry.raw !== false };
  });
}
export function parseCommand(line) {
  const text = line.trim();
  if (!text || text.startsWith('#')) return null;
  if (['help','list','demo'].includes(text)) return { command: text };
  const simple = /^(show|hide|remove)\s+([a-zA-Z0-9_-]{1,64})$/.exec(text);
  if (simple) return { command: simple[1], id: simple[2] };
  if (text.startsWith('add ')) {
    const envelope = JSON.parse(text.slice(4));
    if (!validId(envelope.id)) throw new Error('Script add requires an explicit channel id.');
    return { command: 'add', id: envelope.id, source: parseChannel(JSON.stringify(envelope)) };
  }
  const process = /^process\s+([a-zA-Z0-9_-]{1,64})\s+(.+)$/.exec(text);
  if (process) return { command: 'process', id: process[1], processing: validateProcessing(JSON.parse(process[2])) };
  throw new Error('Unknown command. Type help for examples.');
}
export function validateScript(text, existing = []) {
  const states = new Map(existing.map(e => [e.id, e.source]));
  const commands = text.split(/\r?\n/).map((line, i) => {
    try { return parseCommand(line); } catch (error) { throw new Error(`Line ${i + 1}: ${error.message}`); }
  }).filter(Boolean);
  if (commands.length > 200) throw new Error('A script may contain at most 200 commands.');
  for (const c of commands) {
    if (c.command === 'add') {
      if (states.has(c.id) || states.size >= 32) throw new Error(`Cannot add ${c.id}: duplicate ID or channel limit.`);
      states.set(c.id, c.source);
    } else if (['process','show','hide','remove'].includes(c.command)) {
      if (!states.has(c.id)) throw new Error(`Unknown channel ${c.id}.`);
      if (c.command === 'process') processChannel(states.get(c.id), c.processing);
      if (c.command === 'remove') states.delete(c.id);
    } else if (c.command === 'demo') throw new Error('Use the demo button; scripts need explicit IDs for reproducibility.');
  }
  return commands;
}
