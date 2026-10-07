import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseChannel, processChannel } from '../channels.js';
import { sourceEnvelope, validateSession, validateScript } from '../session.js';
const source = { schemaVersion:1, name:'Contact', kind:'digital', stage:'raw', data:{encoding:'bits',intervalUs:1000,values:'001?10'} };
test('session retains original observations and reapplies its processing recipe', () => {
  const parsed = parseChannel(JSON.stringify(source));
  const original = sourceEnvelope(parsed);
  assert.equal(original.data.points.length, 6); // raw sample observations are not compacted
  const session = { kind:'sensehub-session', version:1, channels:[{id:'door',source:original,processing:{invert:true,debounceUs:1000}}] };
  const [entry] = validateSession(session);
  assert.deepEqual(entry.source.points, parsed.points);
  assert.deepEqual(processChannel(entry.source, entry.processing).points, processChannel(parsed, session.channels[0].processing).points);
  assert.throws(() => validateSession({...session,channels:[...session.channels,...session.channels]}));
});
test('DSL scripts are validated as a whole and never evaluate executable code', async () => {
  const commands = validateScript(await readFile(new URL('../examples/optical-bench.sensehub', import.meta.url), 'utf8'));
  assert.equal(commands.length, 5);
  assert.throws(() => validateScript(`add ${JSON.stringify({...source,id:'door'})}\nprocess missing {"invert":true}`));
  assert.throws(() => validateScript('globalThis.steal()'));
  assert.throws(() => validateScript(`add ${JSON.stringify({...source,id:'door'})}\nprocess door {"surprise":true}`));
  assert.throws(() => validateScript(`add ${JSON.stringify({...source,id:'door'})}\nprocess door {"debounceUs":-1}`));
});
