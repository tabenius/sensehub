export function crc16(bytes, initial = 0xffff) {
  let crc = initial;
  for (const byte of bytes) { crc ^= byte << 8; for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff; }
  return crc;
}
export function encodeFrame(type, payload = new Uint8Array()) {
  if (payload.length > 4096) throw new Error('Payload exceeds protocol limit.');
  const out = new Uint8Array(payload.length + 7);
  out.set([0x53,0x48,type,payload.length >> 8,payload.length & 255]); out.set(payload, 5);
  const crc = crc16(out.subarray(2, out.length - 2)); out[out.length - 2] = crc >> 8; out[out.length - 1] = crc & 255; return out;
}
export class FrameParser {
  constructor() { this.buffer = new Uint8Array(); }
  feed(bytes) {
    const merged = new Uint8Array(this.buffer.length + bytes.length); merged.set(this.buffer); merged.set(bytes, this.buffer.length);
    const frames = []; let at = 0;
    while (at + 1 < merged.length) {
      if (merged[at] !== 0x53 || merged[at + 1] !== 0x48) { at++; continue; }
      if (merged.length - at < 5) break;
      const length = merged[at + 3] << 8 | merged[at + 4];
      if (length > 4096) { at++; continue; }
      if (merged.length - at < length + 7) break;
      const expected = merged[at + length + 5] << 8 | merged[at + length + 6];
      if (crc16(merged.subarray(at + 2, at + length + 5)) !== expected) { at++; continue; }
      frames.push({ type:merged[at + 2], payload:merged.slice(at + 5, at + length + 5) }); at += length + 7;
    }
    this.buffer = merged.slice(at); if (this.buffer.length > 4103) this.buffer = this.buffer.slice(-1);
    return frames;
  }
}
export function decodeDigital(payload, sourceId = 'esp32') {
  if (payload.length !== 20) throw new Error('Digital observation must be 20 bytes.');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength), time = view.getBigUint64(1);
  if (time > BigInt(Number.MAX_SAFE_INTEGER) || payload[9] > 1 || payload[10] > 1 || payload[11] > 3) throw new Error('Invalid digital observation.');
  return { source:'gpio', sourceId, kind:'digital', channel:payload[0], number:null,
    raw:payload[9], value:payload[11] & 1 ? null : payload[10], max:1, gap:Boolean(payload[11] & 2),
    tUs:Number(time), sequence:view.getUint32(12), revision:view.getUint32(16) };
}
export function encodeChannelConfig({ id, pin, pull = 1, invert = true, pollMs = 10, debounceMs = 20 }) {
  if (![id,pin,pull,pollMs,debounceMs].every(Number.isInteger) || id < 0 || id > 255 || pin < 0 || pin > 63 || pull < 0 || pull > 2 || pollMs < 1 || pollMs > 60000 || debounceMs < 0 || debounceMs > 60000) throw new Error('Invalid button configuration.');
  const payload = new Uint8Array(16), view = new DataView(payload.buffer);
  payload.set([id,1,pin,pull,Number(Boolean(invert))]); view.setUint16(5,pollMs); view.setUint16(7,debounceMs);
  return encodeFrame(0x21,payload);
}
export function decodeChannelState(payload) {
  if (payload.length !== 20) throw new Error('Channel state must be 20 bytes.');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { id:payload[0], mode:payload[1], pin:payload[2], pull:payload[3], invert:Boolean(payload[4]),
    pollMs:view.getUint16(5), debounceMs:view.getUint16(7), output:payload[9], frequency:view.getUint32(10), duty:view.getUint16(14), revision:view.getUint32(16) };
}
export function gpioChannelId(sourceId, channel) {
  let hash=0x811c9dc5;
  for(const byte of new TextEncoder().encode(sourceId))hash=Math.imul(hash^byte,0x01000193)>>>0;
  return `gpio-${sourceId.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,30)}-${hash.toString(16).padStart(8,'0')}-${channel}`;
}
export function usbIpCommands(host, busId, ssh = '') {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,253}$/.test(host) || !/^\d+-\d+(?:\.\d+)*$/.test(busId)) throw new Error('Enter a host and a USB/IP bus ID such as 1-2.');
  if (ssh && !/^[a-zA-Z0-9][a-zA-Z0-9@._:-]{0,253}$/.test(ssh)) throw new Error('Invalid SSH destination.');
  const commands = [`usbip list -r '${host}'`];
  if (ssh) commands.push(`ssh -N -L 3240:127.0.0.1:3240 '${ssh}'`, `sudo modprobe vhci-hcd`, `sudo usbip attach -r '127.0.0.1' -b '${busId}'`);
  else commands.push('sudo modprobe vhci-hcd', `sudo usbip attach -r '${host}' -b '${busId}'`);
  return commands;
}
