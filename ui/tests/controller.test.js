import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMidi, defaultBinding, mapEvent, validateBinding, validateControlMap, OscillatorBank, noteHz } from '../controller-core.js';
import { FrameParser, crc16, encodeFrame, encodeChannelConfig, decodeChannelState, decodeDigital, gpioChannelId, usbIpCommands } from '../transport.js';

test('MIDI channels, note-off velocity zero and 14-bit bend are decoded precisely', () => {
  assert.equal(decodeMidi([0xb2,14,96]).channel, 3);
  assert.equal(decodeMidi([0x90,69,0]).value, 0);
  assert.equal(decodeMidi([0x80,69,127]).value, 0);
  assert.equal(decodeMidi([0xe0,0,64]).value, 8192);
  assert.equal(decodeMidi([0xe0,127,127]).value, 16383);
  assert.equal(decodeMidi([0xb0,128,0]), null);
  assert.equal(decodeMidi([0xf8]), null);
  assert.equal(noteHz(69), 440);
});
test('learned filters and logarithmic/linear/range-free representations are independent', () => {
  const b=defaultBinding('frequency',{sourceId:'keyboard',number:14});
  assert.equal(mapEvent(b,decodeMidi([0xb0,14,0],'keyboard')),20);
  assert.equal(mapEvent(b,decodeMidi([0xb0,14,127],'keyboard')),4000);
  assert.equal(mapEvent(b,decodeMidi([0xb1,14,127],'keyboard')),null);
  assert.equal(mapEvent(b,decodeMidi([0xb0,14,127],'other')),null);
  const unbounded={...b,range:null,curve:'linear',scale:-0.5,offset:2};
  assert.equal(mapEvent(unbounded,decodeMidi([0xb0,14,10],'keyboard')),-3);
  const integer={...b,output:'integer'};assert.equal(mapEvent(integer,decodeMidi([0xb0,14,127],'keyboard')),127);
});
test('relative encoders and fresh-press toggles do not turn repeated HIGH into repeated toggles', () => {
  const b=defaultBinding('relative',{number:14,mode:'twos-complement',range:null,curve:'linear',scale:0.1});
  assert.equal(mapEvent(b,decodeMidi([0xb0,14,127]),2),1.9);
  assert.equal(mapEvent({...b,mode:'sign-bit'},decodeMidi([0xb0,14,65]),2),1.9);
  const toggle=defaultBinding('switch',{source:'gpio',kind:'digital',channel:8,number:null,output:'binary',range:null,curve:'linear',target:'A.gate',behavior:'toggle'});
  const e={source:'gpio',kind:'digital',channel:8,number:null,value:1,max:1};
  assert.equal(mapEvent(toggle,e,0,false),1);
  assert.equal(mapEvent(toggle,e,1,true),1);
  assert.equal(mapEvent(toggle,{...e,value:0},1,true),1);
  assert.equal(mapEvent(toggle,{...e,value:null},1,true),null);
});
test('virtual inputs are phase-continuous, deterministic and bounded by explicit gates', () => {
  const a=new OscillatorBank(),b=new OscillatorBank();
  assert.deepEqual(a.render(20).mix,b.render(20).mix);
  a.set('A','frequency',1000);a.set('A','amplitude',1);
  const first=a.render(16).mix,second=a.render(16).mix;
  assert.ok(first.every((v,i)=>Math.abs(v-second[i])<1e-10));
  a.set('A','gate',false);assert.ok(a.render(20).mix.every(v=>v===0));
  for(const shape of ['sine','square','saw','triangle','noise']){a.set('B','enabled',true);a.set('B','shape',shape);assert.ok(a.render(20).mix.every(Number.isFinite));}
  assert.throws(()=>a.set('A','shape','mystery'));assert.throws(()=>a.render(0));
});
test('invalid control maps and contradictory event targets are rejected before import', () => {
  const binding=defaultBinding('x');
  assert.throws(()=>validateBinding({...binding,target:'keyboard'}));
  assert.throws(()=>validateBinding({...binding,source:'gpio'}));
  assert.throws(()=>validateControlMap({kind:'sensehub-controls',version:1,bindings:[binding,binding]}));
  assert.throws(()=>validateControlMap({kind:'sensehub-controls',version:1,bindings:[],custom:{name:'Broken',controls:[]}}));
});
test('ESP32 framing handles split packets, text preambles and CRC corruption', () => {
  assert.equal(crc16(new TextEncoder().encode('123456789')),0x29b1);
  const frame=encodeFrame(0x20),parser=new FrameParser();
  assert.deepEqual(parser.feed(new TextEncoder().encode('transport=usb-framed\n')),[]);
  assert.deepEqual(parser.feed(frame.slice(0,4)),[]);assert.equal(parser.feed(frame.slice(4))[0].type,0x20);
  const bad=frame.slice();bad[bad.length-1]^=1;
  const both=new Uint8Array(bad.length+frame.length);both.set(bad);both.set(frame,bad.length);assert.equal(parser.feed(both).length,1);
});
test('GPIO state preserves raw, conditioned, unknown, gap, timestamp and revision', () => {
  const payload=new Uint8Array(20),view=new DataView(payload.buffer);payload[0]=8;view.setBigUint64(1,1234567890123n);payload[9]=0;payload[10]=1;payload[11]=0;view.setUint32(12,123);view.setUint32(16,7);
  const e=decodeDigital(payload);assert.equal(e.tUs,1234567890123);assert.equal(e.raw,0);assert.equal(e.value,1);assert.equal(e.revision,7);
  payload[11]=3;assert.equal(decodeDigital(payload).value,null);assert.equal(decodeDigital(payload).gap,true);
  assert.throws(()=>decodeDigital(payload.slice(1)));
  const config=encodeChannelConfig({id:8,pin:13});const [{payload:body}]=new FrameParser().feed(config);
  assert.deepEqual(Array.from(body.slice(0,9)),[8,1,13,1,1,0,10,0,20]);
  const state=new Uint8Array(20);state.set(body);new DataView(state.buffer).setUint32(16,0x12345678);
  assert.equal(decodeChannelState(state).revision,0x12345678);
});
test('USB/IP preparation produces explicit host commands and rejects injected shell syntax', () => {
  const commands=usbIpCommands('usb.example','1-2','user@usb.example').join('\n');
  assert.ok(commands.includes('ssh -N -L 3240:127.0.0.1:3240'));
  assert.ok(commands.includes("usbip attach -r '127.0.0.1' -b '1-2'"));
  assert.throws(()=>usbIpCommands('host; reboot','1-2'));
  assert.throws(()=>usbIpCommands('host','--all'));
});
test('GPIO channel identity includes its source rather than colliding across boards', () => {
  assert.notEqual(gpioChannelId('board-one',8),gpioChannelId('board-two',8));
  assert.notEqual(gpioChannelId('board:one',8),gpioChannelId('board_one',8));
  assert.ok(/^[a-zA-Z0-9_-]{1,64}$/.test(gpioChannelId('a'.repeat(100),255)));
});
