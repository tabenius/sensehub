import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProxy } from '../server.mjs';

const raw = { schemaVersion:1, name:'Contact', kind:'digital', stage:'raw', data:{ encoding:'bits', intervalUs:1000, values:'001?10' } };
const processed = { ...raw, stage:'conditioned', data:{ ...raw.data, values:'000?11' } };

test('proxy preserves originals, separates branches and atomically rejects invalid batches', async () => {
  const { server, stop } = createProxy(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${url}/api/channels`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ channels:[{id:'contact',raw,processed}] }) });
    assert.equal(response.status, 200);
    const original = await (await fetch(`${url}/api/channels/contact?branch=raw`)).json();
    assert.deepEqual(original.raw, raw); assert.equal(original.processed, undefined);
    const derived = await (await fetch(`${url}/api/channels/contact?branch=processed`)).json();
    assert.deepEqual(derived.processed, processed); assert.equal(derived.raw, undefined);
    response = await fetch(`${url}/api/channels`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({channels:[{id:'valid',raw},{id:'invalid',raw:{...raw,data:{...raw.data,values:'012'}}}]}) });
    assert.equal(response.status, 400);
    assert.equal((await (await fetch(`${url}/api/channels`)).json()).channels.length, 1);
    response = await fetch(`${url}/api/channels/contact`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({raw:{...raw,name:'Updated'}}) });
    assert.equal(response.status, 200);
    const mixed = await (await fetch(`${url}/api/channels/contact`)).json();
    assert.ok(mixed.rawRevision > mixed.processedRevision); // no claim of synchronized stale branch
    assert.equal((await fetch(`${url}/`)).status, 200);
  } finally { await stop(); }
});

test('SSE sends fresh snapshots, filtered updates and removals to independent clients', async () => {
  const { server, stop } = createProxy(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`, controller = new AbortController();
  let processedReader;
  try {
    const response = await fetch(`${url}/api/events?branch=raw&ids=contact`, { signal:controller.signal });
    const processedResponse = await fetch(`${url}/api/events?branch=processed&ids=contact`, { signal:controller.signal });
    processedReader = processedResponse.body.getReader();
    const reader = response.body.getReader(), decoder = new TextDecoder(); let accumulated = '';
    async function waitFor(text) {
      const timer = setTimeout(() => controller.abort(), 3000);
      try { while (!accumulated.includes(text)) { const result = await reader.read(); if (result.done) throw new Error('Stream ended.'); accumulated += decoder.decode(result.value); } }
      finally { clearTimeout(timer); }
    }
    await waitFor('event: snapshot'); assert.ok(accumulated.includes('"channels":[]'));
    await fetch(`${url}/api/channels/contact`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({raw,processed})});
    await waitFor('event: channel'); assert.ok(accumulated.includes('001?10')); assert.ok(!accumulated.includes('000?11'));
    let derivedMessages = '';
    while (!derivedMessages.includes('000?11')) { const chunk = await processedReader.read(); if (chunk.done) throw new Error('Derived stream ended.'); derivedMessages += decoder.decode(chunk.value); }
    assert.ok(!derivedMessages.includes('001?10'));
    await fetch(`${url}/api/channels/contact`, {method:'DELETE'});
    await waitFor('event: removed'); await reader.cancel(); await processedReader.cancel();
  } finally { controller.abort(); await stop(); }
});
