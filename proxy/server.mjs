import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseChannel } from '../ui/channels.js';
import { validId } from '../ui/session.js';

const uiRoot = fileURLToPath(new URL('../ui/', import.meta.url));
const LIMIT = 8 * 1024 * 1024, TOTAL_LIMIT = 64 * 1024 * 1024;
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.sensehub':'text/plain', '.txt':'text/plain' };

export function createProxy() {
  const records = new Map(), clients = new Set(); let revision = 0;
  function select(record, branch) {
    const result = { id: record.id, revision: record.revision, updatedAt: record.updatedAt };
    for (const key of ['raw','processed']) if (branch === 'both' || branch === key) {
      if (record[key]) { result[key] = record[key]; result[`${key}Revision`] = record[`${key}Revision`]; }
    }
    return result;
  }
  function emit(client, event, data) {
    if (client.response.destroyed || client.response.writableLength > LIMIT) { client.response.destroy(); clients.delete(client); return; }
    client.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function publish(record) { for (const client of clients) if (!client.ids || client.ids.has(record.id)) emit(client, 'channel', select(record, client.branch)); }
  function json(response, status, value) { response.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }); response.end(JSON.stringify(value)); }
  async function body(request) {
    if ((request.headers['content-type'] ?? '').split(';')[0] !== 'application/json') throw Object.assign(new Error('Use application/json.'), { status:415 });
    const chunks = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; if (length > LIMIT) throw Object.assign(new Error('Request exceeds 8 MB.'), { status:413 }); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  function validateBatch(values) {
    if (!Array.isArray(values) || values.length === 0 || values.length > 64) throw new Error('Provide 1–64 channel records.');
    const staged = new Map(records), ids = new Set();
    for (const value of values) {
      if (!value || !validId(value.id) || ids.has(value.id)) throw new Error('Channel IDs must be unique identifiers.');
      ids.add(value.id);
      if (!value.raw && !value.processed) throw new Error('Provide raw, processed or both branches.');
      const next = { ...(staged.get(value.id) ?? {}), id: value.id };
      for (const branch of ['raw','processed']) if (value[branch]) {
        parseChannel(JSON.stringify(value[branch])); // type/timing/size validation, not normalization
        next[branch] = structuredClone(value[branch]); next[`${branch}Revision`] = revision + 1;
      }
      next.revision = revision + 1; next.updatedAt = new Date().toISOString(); staged.set(value.id, next);
    }
    if (staged.size > 64 || Buffer.byteLength(JSON.stringify([...staged.values()])) > TOTAL_LIMIT) throw Object.assign(new Error('Proxy storage budget exceeded.'), { status:413 });
    return { staged, ids };
  }
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    // Intended for local work/tunnel clients; no credentialed CORS or hardware commands.
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    try {
      if (url.pathname === '/api/health') { json(response, 200, { service:'sensehub-channel-proxy', version:1, revision, channels:records.size }); return; }
      const branch = url.searchParams.get('branch') ?? 'both';
      if (!['raw','processed','both'].includes(branch)) throw new Error('branch must be raw, processed or both.');
      const ids = url.searchParams.has('ids') ? new Set(url.searchParams.get('ids').split(',')) : null;
      if (url.pathname === '/api/events' && request.method === 'GET') {
        if (clients.size >= 16) { json(response, 503, { error:'Subscriber limit reached.' }); return; }
        response.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive', 'X-Accel-Buffering':'no' });
        response.write('retry: 2000\n\n');
        const client = { response, branch, ids }; clients.add(client);
        // Reset marker followed by bounded per-channel messages, not one giant
        // snapshot serialization. Reconnect always rebuilds the latest state.
        emit(client, 'snapshot', { revision, channels:[] });
        for (const record of records.values()) if (!ids || ids.has(record.id)) emit(client, 'channel', select(record, branch));
        const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n'); }, 15000);
        response.on('close', () => { clearInterval(heartbeat); clients.delete(client); }); return;
      }
      const match = /^\/api\/channels\/([a-zA-Z0-9_-]{1,64})$/.exec(url.pathname);
      if ((url.pathname === '/api/channels' || match) && request.method === 'GET') {
        if (match) { const record = records.get(match[1]); json(response, record ? 200 : 404, record ? select(record, branch) : { error:'Unknown channel.' }); }
        else json(response, 200, { revision, channels:Array.from(records.values()).filter(r => !ids || ids.has(r.id)).map(r => select(r, branch)) });
        return;
      }
      if ((url.pathname === '/api/channels' && request.method === 'POST') || (match && request.method === 'PUT')) {
        const value = await body(request);
        const { staged, ids: changed } = validateBatch(match ? [{ ...value, id:match[1] }] : value.channels);
        revision++; records.clear(); for (const [id, record] of staged) records.set(id, record);
        for (const id of changed) publish(records.get(id));
        json(response, 200, { revision, updated:Array.from(changed) }); return;
      }
      if (match && request.method === 'DELETE') {
        if (!records.delete(match[1])) { json(response, 404, { error:'Unknown channel.' }); return; }
        revision++;
        for (const client of clients) if (!client.ids || client.ids.has(match[1])) emit(client, 'removed', { id:match[1], revision });
        json(response, 200, { revision }); return;
      }
      if (url.pathname.startsWith('/api/')) { json(response, 404, { error:'Unknown API route.' }); return; }
      if (request.method !== 'GET') { json(response, 405, { error:'Method not allowed.' }); return; }
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const filename = path.resolve(uiRoot, `.${relative}`);
      if (!filename.startsWith(uiRoot) || !MIME[path.extname(filename)]) { json(response, 404, { error:'Unknown asset.' }); return; }
      const bytes = await readFile(filename);
      response.writeHead(200, { 'Content-Type':MIME[path.extname(filename)], 'Cache-Control':'no-cache' }); response.end(bytes);
    } catch (error) { if (!response.headersSent) json(response, error.code === 'ENOENT' ? 404 : error.status ?? 400, { error:error.message }); else response.end(); }
  });
  // Close only SSE responses owned by this server, then normal HTTP connections.
  const stop = async () => { for (const client of clients) client.response.end(); clients.clear(); server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); };
  return { server, stop };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options:{ bind:{ type:'string', default:'127.0.0.1' }, port:{ type:'string', default:'8903' } } });
  const port = Number(values.port); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  const { server } = createProxy();
  server.listen(port, values.bind, () => console.log(`SenseHub UI + channel proxy: http://${values.bind}:${server.address().port}/`));
}
