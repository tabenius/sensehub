import { uPlot, select, scaleLinear, scaleLog } from './vendor/visualization.js';
import { OscillatorBank, defaultBinding, decodeMidi, mapEvent, matches, validateBinding, validateControlMap, noteHz } from './controller-core.js';
import { FrameParser, decodeDigital, decodeChannelState, encodeFrame, encodeChannelConfig, gpioChannelId, usbIpCommands } from './transport.js';

const template = await fetch(new URL('./controller-view.html', import.meta.url)).then(r => { if (!r.ok) throw new Error('Controller view unavailable.'); return r.text(); });
document.querySelector('.channel-lab').insertAdjacentHTML('beforebegin', template);
const get = id => document.getElementById(id), bank = new OscillatorBank();
for(const id of ['B','C','D'])for(const parameter of ['frequency','amplitude','phase','duty','gate'])get('binding-target').append(new Option(`Oscillator ${id} ${parameter}`,`${id}.${parameter}`));
const bindings = new Map(), values = new Map(), knownValues = new Map(), pressed = new Map(), captures = new Map(), heldNotes = new Map(), observedNotes = new Map();
const linkedCaptures=new Set();let virtualLinked=false;
const suppressedChannels=new Set();
document.addEventListener('sensehub:channel-removed',event=>{
  const id=event.detail.id;
  if(id==='virtual-waveform')virtualLinked=false;
  for(const key of linkedCaptures)if(`control-${key.replace(/[^a-zA-Z0-9_-]/g,'_')}`===id)linkedCaptures.delete(key);
  if(id.startsWith('gpio-'))suppressedChannels.add(id);
});
let profile = 'hercules', selected = null, learning = false, running = false, guided = false, lastFrame = 0, frame = bank.render();
let midiAccess = null, serialPort = null, reader = null, writer = null, serialReading = false, serialReadFinished = null, handshakeTimer = null, serialSource = 'esp32', deviceCapabilities = null;
let knownMidiPorts=new Set();
const parser = new FrameParser(), eventLog = [], controlValues = new Map();
const profiles = {
  hercules: { name:'Hercules Inpulse MK2 · conceptual family layout', controls:[] },
  umx: { name:'UMX610 · conceptual 61-key layout', controls:[] },
  gpio: { name:'GPIO construction kit · user-declared input roles', controls:[] },
  custom: { name:'My device', controls:[], image:null },
};
for (const [deck, x] of [['L',230],['R',770]]) {
  profiles.hercules.controls.push({id:`${deck}-jog`,label:`Deck ${deck} jog`,type:'knob',x,y:230,radius:72,target:'A.phase'},
    {id:`${deck}-play`,label:`Deck ${deck} play`,type:'toggle',x:x-58,y:340,target:'A.gate'},
    {id:`${deck}-cue`,label:`Deck ${deck} cue`,type:'button',x:x+58,y:340,target:'A.gate'},
    {id:`${deck}-gain`,label:`Deck ${deck} gain`,type:'knob',x,y:85,target:'A.amplitude'});
}
for (const [i, label] of ['Frequency','Amplitude','Pulse width'].entries()) profiles.hercules.controls.push({id:`mix-${i}`,label,type:'knob',x:415+i*85,y:100,target:['A.frequency','A.amplitude','A.duty'][i]});
profiles.hercules.controls.push({id:'left-fader',label:'Channel 1 fader',type:'slider',x:425,y:235,height:125,target:'A.amplitude'}, {id:'right-fader',label:'Channel 2 fader',type:'slider',x:575,y:235,height:125,target:'A.amplitude'}, {id:'crossfader',label:'Crossfader',type:'slider',x:500,y:340,width:150,horizontal:true,target:'A.amplitude'});
for (let i=0;i<8;i++) profiles.umx.controls.push({id:`knob-${i+1}`,label:`Knob ${i+1}`,type:'knob',x:280+i*80,y:85,target:['A.frequency','A.amplitude','A.phase','A.duty'][i%4]}, {id:`button-${i+1}`,label:`Button ${i+1}`,type:'button',x:280+i*80,y:170,target:'A.gate'});
profiles.umx.controls.push({id:'pitch',label:'Pitch wheel',type:'slider',x:55,y:105,height:100,target:'A.frequency'}, {id:'mod',label:'Mod wheel',type:'slider',x:135,y:105,height:100,target:'A.amplitude'}, {id:'volume',label:'Volume',type:'slider',x:950,y:120,height:100,target:'A.amplitude'});
let white = 0;
for (let note=36;note<=96;note++) {
  const black = [1,3,6,8,10].includes(note%12);
  profiles.umx.controls.push({id:`key-${note}`,label:`MIDI note ${note} · ${noteHz(note).toFixed(1)} Hz`,type:'key',note,x:50+(black?white*25-8:white++*25),y:230,width:black?16:24,height:black?90:155,black,target:'keyboard'});
}
for (const [i,label] of ['Pushbutton','Toggle switch','Reed contact','Limit switch'].entries()) profiles.gpio.controls.push({id:`gpio-${i}`,label,type:i===1?'toggle':'button',x:160+i*220,y:220,channel:8+i,target:'A.gate'});
profiles.custom.controls.push({id:'control-1',label:'My knob',type:'knob',x:150,y:85,target:'A.frequency'});

function key(control) { return `${profile}:${control.type==='key'&&profile==='umx'?'keyboard':control.id}`; }
function bindingFor(control) {
  const id = key(control);
  if (!bindings.has(id)) {
    const target = control.target??'channel', button = ['button','toggle'].includes(control.type), keyboard = control.type==='key';
    bindings.set(id, defaultBinding(id, { source:profile==='gpio'?'gpio':'virtual', sourceId:null,
      kind:profile==='gpio'?'digital':keyboard?'note':'value', channel:profile==='gpio'?control.channel:0, number:null,
      output:keyboard?'event':button?'binary':'float', range:keyboard||button?null:target.endsWith('frequency')?[20,4000]:[0,1],
      curve:target.endsWith('frequency')&&!keyboard?'log':'linear', target, behavior:control.type==='toggle'&&profile!=='gpio'?'toggle':'momentary', binaryRule:button?'nonzero':'half' }));
  }
  const visualId=`${profile}:${control.id}`;
  if(!controlValues.has(visualId)){
    const b=bindings.get(id),[osc,param]=b.target.split('.'),actual=bank.oscillators.find(o=>o.id===osc)?.[param];
    let fraction=['button','toggle','key'].includes(control.type)?0:0.5;
    if(typeof actual==='number'&&b.range)fraction=b.curve==='log'?Math.log(actual/b.range[0])/Math.log(b.range[1]/b.range[0]):(actual-b.range[0])/(b.range[1]-b.range[0]);
    controlValues.set(visualId,Math.max(0,Math.min(1,fraction)));
  }
  return bindings.get(id);
}
try {
  const stored = JSON.parse(localStorage.getItem('sensehub.controls.v1'));
  if (stored?.kind==='sensehub-controls'&&stored.version===1&&Array.isArray(stored.bindings)&&stored.bindings.length<=200) stored.bindings.map(validateBinding).forEach(b=>bindings.set(b.id,b));
  if(typeof stored?.presentation?.hoverHints==='boolean')get('controller-hover').checked=stored.presentation.hoverHints;
} catch { /* invalid or inaccessible preferences do not prevent drawing */ }
function persist() { try { localStorage.setItem('sensehub.controls.v1',JSON.stringify({kind:'sensehub-controls',version:1,bindings:[...bindings.values()],presentation:{hoverHints:get('controller-hover').checked}})); } catch { /* optional */ } }
get('controller-hover').addEventListener('change',persist);
function resetBinding(id){
  if(bindings.get(id)?.target==='keyboard'){heldNotes.clear();observedNotes.clear();bank.set('A','gate',false);for(const c of profiles.umx.controls)if(c.type==='key')controlValues.set(`umx:${c.id}`,0);}
  values.delete(id);knownValues.delete(id);for(const key of [...pressed.keys()])if(key.startsWith(`${id}|`))pressed.delete(key);captures.delete(id);
}
function save(name, object) { const url=URL.createObjectURL(new Blob([JSON.stringify(object,null,2)],{type:'application/json'})); const a=document.createElement('a'); a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
function status(text) { get('binding-status').textContent=text; }

function choose(control) {
  selected=control; learning=false; get('midi-learn').classList.remove('learning');
  const b=bindingFor(control);
  get('selected-control').textContent=control.label;
  for (const [id,field] of [['source','source'],['kind','kind'],['channel','channel'],['number','number'],['port','sourceId'],['output','output'],['target','target'],['curve','curve'],['mode','mode'],['behavior','behavior'],['scale','scale'],['offset','offset']]) get(`binding-${id}`).value=b[field]??'';
  get('binding-bounded').checked=Boolean(b.range);get('binding-min').value=b.range?.[0]??0;get('binding-max').value=b.range?.[1]??1;
  get('binding-binary-rule').value=b.binaryRule??'half';
  get('selected-value').value=Math.round((controlValues.get(`${profile}:${control.id}`)??0.5)*127);
  get('selected-value').closest('label').hidden=['button','toggle','key'].includes(control.type);get('selected-press').hidden=!['button','toggle','key'].includes(control.type);get('selected-press').textContent=`Press ${control.label}`;
  updateInspectorFields();updateDrawing();describe(control);
}
function updateInspectorFields() {
  const source=get('binding-source').value, output=get('binding-output').value, kind=get('binding-kind').value;
  const kinds=source==='midi'?['cc','note','pitchbend']:source==='gpio'?['digital']:['value','note','digital'];
  for(const option of get('binding-kind').options)option.disabled=!kinds.includes(option.value);
  get('binding-channel').min=source==='midi'?1:0;get('binding-channel').max=source==='midi'?16:255;
  get('binding-number').closest('label').hidden=source!=='midi'||kind==='pitchbend';
  get('binding-port').closest('label').hidden=source==='virtual';
  for(const id of ['binding-min','binding-max','binding-curve','binding-mode','binding-scale','binding-offset']) get(id).closest('label').hidden=output!=='float';
  const bounded=get('binding-bounded').checked, relative=get('binding-mode').value!=='absolute';
  for(const id of ['binding-min','binding-max'])get(id).closest('label').hidden=output!=='float'||!bounded;
  get('binding-curve').closest('label').hidden=output!=='float'||!bounded||relative;
  get('binding-scale').closest('label').hidden=output!=='float'||(!relative&&bounded);
  get('binding-offset').closest('label').hidden=output!=='float'||relative||bounded;
  get('binding-mode').closest('label').hidden=output!=='float'||source!=='midi'||kind!=='cc';
  get('binding-bounded').closest('label').hidden=output!=='float';get('binding-behavior').closest('label').hidden=output!=='binary';
  get('binding-binary-rule').closest('label').hidden=output!=='binary';
  get('binding-source-pill').textContent=source==='gpio'?'GPIO channel':source==='midi'?'MIDI message':'On-screen control';
  get('binding-output-pill').textContent=output==='float'?`Float · ${bounded?'ranged':'unbounded'}`:output;get('binding-target-pill').textContent=get('binding-target').selectedOptions[0].textContent;
}
for(const id of ['binding-source','binding-output','binding-kind','binding-target']) get(id).addEventListener('change',()=>{
  if(id==='binding-source'){const source=get(id).value;get('binding-kind').value=source==='gpio'?'digital':source==='midi'?'cc':'value';get('binding-channel').value=source==='midi'?1:source==='gpio'?8:0;get('binding-mode').value='absolute';}
  updateInspectorFields();
});
get('binding-bounded').addEventListener('change',()=>{if(!get('binding-bounded').checked)get('binding-curve').value='linear';updateInspectorFields();});
get('binding-mode').addEventListener('change',updateInspectorFields);
get('binding-form').addEventListener('submit',event=>{
  event.preventDefault();if(!selected)return;
  try{
    const source=get('binding-source').value, number=source==='midi'&&get('binding-kind').value!=='pitchbend'&&get('binding-number').value!==''?Number(get('binding-number').value):null;
    const output=get('binding-output').value;
    const b=validateBinding({id:key(selected),source,sourceId:get('binding-port').value||null,kind:get('binding-kind').value,channel:get('binding-channel').value===''?null:Number(get('binding-channel').value),number,output,target:get('binding-target').value,
      range:output==='float'&&get('binding-bounded').checked?[Number(get('binding-min').value),Number(get('binding-max').value)]:null,
      curve:output==='float'?get('binding-curve').value:'linear',mode:output==='float'?get('binding-mode').value:'absolute',scale:Number(get('binding-scale').value),offset:Number(get('binding-offset').value),behavior:get('binding-behavior').value,binaryRule:get('binding-binary-rule').value});
    resetBinding(b.id);bindings.set(b.id,b);persist();status('Binding applied. On-screen and incoming values use this output transformation.');choose(selected);
  }catch(error){status(error.message);}
});
get('midi-learn').addEventListener('click',()=>{if(!selected)return;learning=!learning;get('midi-learn').classList.toggle('learning',learning);status(learning?'Listening: move a hardware control or use Simulate MIDI / button. Unknown GPIO observations are not learned.':'Learning cancelled.');});

function describe(control) {
  const b=bindingFor(control), value=values.get(b.id);
  get('control-tooltip').textContent=`${control.label} · ${b.source}/${b.kind} channel ${b.channel??'any'}${b.number===null?'':` number ${b.number}`} → ${b.output}${b.range?` [${b.range.join(', ')}]`:''} → ${b.target} · ${value===undefined?'awaiting value':value===null?'unknown':typeof value==='object'?JSON.stringify(value):Number(value).toFixed(3)}. Drag / tap / arrow keys; select Learn to bind a physical input.`;
}
function capture(id,value,event) {
  if(bindings.get(id)?.output==='event'||value!==null&&typeof value==='object')return;
  let c=captures.get(id);const now=Math.round(performance.now()*1000);
  if(!c){c={origin:now,points:[],sources:[],kind:bindings.get(id)?.output==='binary'?'digital':'numeric',name:id};captures.set(id,c);}
  const tUs=Math.max(c.points.at(-1)?.tUs+1||0,now-c.origin);c.points.push({tUs,value});if(c.points.length>512)c.points.shift();c.endUs=tUs+1000;
  c.sources.push({sourceId:event.sourceId,sourceTimeUs:event.tUs??null,revision:event.revision??null});if(c.sources.length>512)c.sources.shift();
  if(linkedCaptures.has(id))emitCapture(id,c);
}
function emitCapture(id,c){window.sensehubLab.upsertChannel(`control-${id.replace(/[^a-zA-Z0-9_-]/g,'_')}`,{schemaVersion:1,name:`Mapped ${id}`,kind:c.kind,stage:'conditioned',unit:c.kind==='digital'?'logic':'mapped units',provenance:{binding:bindings.get(id),clock:'host-mapped-event-us',sourceTimes:c.sources},data:{encoding:'edges',points:c.points,endUs:c.endUs}});}
function logEvent(value){eventLog.unshift(value);eventLog.length=Math.min(eventLog.length,12);get('controller-events').textContent=eventLog.map(e=>JSON.stringify(e)).join('\n');}
function noteState(event){
  const id=`${event.sourceId}:${event.channel}:${event.number}`;
  if(event.value>0)observedNotes.set(id,event.number);else observedNotes.delete(id);
  const notes=new Set(observedNotes.values());for(const c of profiles.umx.controls)if(c.type==='key')controlValues.set(`umx:${c.id}`,notes.has(c.note)?1:0);
}
function applyResult(id,value,event) {
  const b=bindings.get(id);if(!b)return;
  if(value!==null&&event.source!=='virtual')guided=false;
  if(typeof value==='number'){
    const fraction=b.output==='binary'?value:b.output==='float'&&b.range?(b.curve==='log'?Math.log(value/b.range[0])/Math.log(b.range[1]/b.range[0]):(value-b.range[0])/(b.range[1]-b.range[0])):b.mode!=='absolute'?((value/128)%1+1)%1:event.value/event.max;
    for(const [name,p]of Object.entries(profiles))for(const c of p.controls)if(`${name}:${c.type==='key'&&name==='umx'?'keyboard':c.id}`===id)controlValues.set(`${name}:${c.id}`,Math.max(0,Math.min(1,fraction)));
  }
  values.set(id,value);if(value!==null)knownValues.set(id,value);capture(id,value,event);let applied=null;
  if(value!==null){
    if(b.target==='keyboard'&&typeof value==='object'&&value.kind==='note'){
      noteState(value);
      const noteKey=`${value.sourceId}:${value.channel}:${value.number}`;
      if(value.value>0)heldNotes.set(noteKey,value.number);else heldNotes.delete(noteKey);
      const note=[...heldNotes.values()].at(-1);bank.set('A','gate',note!==undefined);if(note!==undefined){bank.set('A','frequency',noteHz(note));bank.set('A','enabled',true);}
    }else if(b.target!=='channel'&&typeof value==='number'){
      const [osc,param]=b.target.split('.');if(osc&&param)applied=bank.set(osc,param,value);
    }
  }
  const active=event.kind==='note'||b.binaryRule==='nonzero'?event.value>0:event.value!==null&&event.value>=event.max/2;
  pressed.set(`${id}|${event.sourceId}|${event.channel}|${event.number}`,event.value===null?null:active);
  logEvent({source:event.source,sourceId:event.sourceId,kind:event.kind,channel:event.channel,number:event.number,input:event.value,output:value,target:b.target,applied,quality:event.value===null?'unknown':event.gap?'observed after gap':'observed'});
  if(selected&&key(selected)===id){describe(selected);if(event.value!==null)get('selected-value').value=Math.round(event.value/event.max*127);}
  updateDrawing();syncOscillatorControls();requestPreview();
}
function incoming(event) {
  if(!event)return;
  get('input-activity').textContent=`${event.source.toUpperCase()} · ${event.kind} · channel ${event.channel} · ${event.value===null?'unknown':event.value}`;
  logEvent({...event,mapped:false});
  if(event.source==='midi'&&event.kind==='cc'&&[120,123].includes(event.number)){
    for(const id of [...heldNotes.keys()])if(id.startsWith(`${event.sourceId}:${event.channel}:`))heldNotes.delete(id);
    for(const [id,note]of [...observedNotes])if(id.startsWith(`${event.sourceId}:${event.channel}:`)){observedNotes.delete(id);controlValues.set(`umx:key-${note}`,0);}
    bank.set('A','gate',heldNotes.size>0);
  }
  if(learning&&selected&&event.value!==null){try{const old=bindingFor(selected),learned=validateBinding({...old,source:event.source,sourceId:event.sourceId,kind:event.kind,channel:event.channel,number:profile==='umx'&&selected.type==='key'?null:event.number,mode:event.kind==='cc'?old.mode:'absolute'});resetBinding(old.id);bindings.set(old.id,learned);persist();choose(selected);status(`Learned ${event.source} ${event.kind}, channel ${event.channel}; output mapping retained.`);}catch(error){status(`Not learned: ${error.message}`);}}
  for(const b of bindings.values())if(matches(b,event)){
    const pressId=`${b.id}|${event.sourceId}|${event.channel}|${event.number}`;
    if(event.source==='gpio'&&event.value!==null&&(event.gap||pressed.get(pressId)==null))pressed.set(pressId,b.binaryRule==='nonzero'?event.value>0:event.value>=event.max/2);
    const value=event.value===null?null:mapEvent(b,event,typeof knownValues.get(b.id)==='number'?knownValues.get(b.id):0,pressed.get(pressId)??false);
    if(value!==null||event.value===null)applyResult(b.id,value,event);
  }
  if(event.source==='midi'&&event.kind==='note'){
    noteState(event);updateDrawing();
  }
}
function operate(control,fraction){
  guided=false;const b=bindingFor(control);const value=Math.round(Math.max(0,Math.min(1,fraction))*127);
  controlValues.set(`${profile}:${control.id}`,value/127);
  const event={source:'virtual',sourceId:`${profile}:${control.id}`,kind:control.type==='key'?'note':'value',channel:0,number:control.type==='key'?b.number??control.note??60:null,value,max:127};
  const direct={...b,source:'virtual',sourceId:null,kind:event.kind,channel:0,number:null,mode:'absolute'};
  applyResult(b.id,mapEvent(direct,event,typeof knownValues.get(b.id)==='number'?knownValues.get(b.id):0,pressed.get(`${b.id}|${event.sourceId}|${event.channel}|${event.number}`)??false),event);
}
get('selected-value').addEventListener('input',()=>{if(selected)operate(selected,Number(get('selected-value').value)/127);});
function selectedLatching(){return selected&&profile==='gpio'&&selected.type==='toggle'&&bindingFor(selected).behavior==='momentary';}
function pressSelected(){if(selected)operate(selected,selectedLatching()?Number(knownValues.get(key(selected))!==1):1);}
function releaseSelected(){if(selected&&!selectedLatching())operate(selected,0);}
get('selected-press').addEventListener('pointerdown',event=>{event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);pressSelected();});
for(const type of ['pointerup','pointercancel'])get('selected-press').addEventListener(type,releaseSelected);
get('selected-press').addEventListener('keydown',event=>{if([' ','Enter'].includes(event.key)&&!event.repeat){event.preventDefault();pressSelected();}});
get('selected-press').addEventListener('keyup',event=>{if([' ','Enter'].includes(event.key)){event.preventDefault();releaseSelected();}});

const svg=select(get('device-drawing'));
const shortLabel=(text,count=16)=>text.length>count?`${text.slice(0,count-1)}…`:text;
function drawDevice(){
  svg.selectAll('*').remove();const p=profiles[profile];
  const sceneHeight=Math.max(420,...p.controls.map(c=>c.y+(c.type==='key'?(c.height??90):c.radius??22)+60));svg.attr('viewBox',`0 0 1000 ${sceneHeight}`);
  svg.append('rect').attr('x',12).attr('y',32).attr('width',976).attr('height',sceneHeight-50).attr('rx',24).attr('fill','#242822').attr('stroke','#717768');
  if(p.image)svg.append('image').attr('href',p.image).attr('x',12).attr('y',32).attr('width',976).attr('height',sceneHeight-50).attr('preserveAspectRatio','xMidYMid meet').attr('opacity',0.7);
  svg.append('text').attr('x',30).attr('y',18).attr('fill','#b7bbad').attr('font-size',12).text(p.name);
  const ordered=[...p.controls.filter(c=>!c.black),...p.controls.filter(c=>c.black)];
  for(const c of ordered){
    bindingFor(c);const g=svg.append('g').datum(c).attr('class',`device-control ${c.type}${c.black?' black':''}`).attr('data-control',c.id).attr('transform',`translate(${c.x},${c.y})`).attr('tabindex',0).attr('role',['knob','slider'].includes(c.type)?'slider':'button').attr('aria-label',c.label).attr('aria-valuemin',0).attr('aria-valuemax',127);
    if(c.type==='knob'){const r=c.radius??22;g.append('circle').attr('class','body').attr('r',r);g.append('line').attr('class','needle').attr('x1',0).attr('y1',0).attr('x2',0).attr('y2',-r+8);g.append('text').attr('text-anchor','middle').attr('y',-r-12).text(shortLabel(c.label,r>40?22:14));g.append('text').attr('class','control-value').attr('text-anchor','middle').attr('y',r+20);}
    else if(c.type==='slider'){const w=c.horizontal?c.width??140:20,h=c.horizontal?20:c.height??120;g.append('rect').attr('x',-Math.max(w,44)/2).attr('y',-Math.max(h,44)/2).attr('width',Math.max(w,44)).attr('height',Math.max(h,44)).attr('fill','transparent');g.append('rect').attr('class','body').attr('x',-w/2).attr('y',-h/2).attr('width',w).attr('height',h).attr('rx',5);g.append('rect').attr('class','slider-thumb').attr('width',c.horizontal?16:38).attr('height',c.horizontal?38:16).attr('fill','#ffb366');g.append('text').attr('text-anchor','middle').attr('y',h/2+24).text(c.label);}
    else if(c.type==='key'){g.append('rect').attr('class','body').attr('width',c.width??44).attr('height',c.height??90).attr('rx',3);if(!c.black&&c.note%12===0)g.append('text').attr('x',(c.width??44)/2).attr('y',(c.height??90)-12).attr('text-anchor','middle').text(`C${Math.floor(c.note/12)-1}`);}
    else{g.append('rect').attr('class','body').attr('x',-36).attr('y',-23).attr('width',72).attr('height',46).attr('rx',8);g.append('text').attr('text-anchor','middle').attr('y',4).text(c.type==='toggle'?'⏻':'●');g.append('text').attr('text-anchor','middle').attr('y',44).text(shortLabel(c.label));}
    let drag=null;
    g.on('focus',()=>choose(c)).on('pointerenter',()=>{if(get('controller-hover').checked)describe(c);}).on('click',()=>choose(c));
    const latching=()=>profile==='gpio'&&c.type==='toggle'&&bindingFor(c).behavior==='momentary';
    g.on('pointerdown',function(event){event.preventDefault();this.setPointerCapture(event.pointerId);choose(c);const p=point(event);drag={x:p.x,y:p.y,value:controlValues.get(`${profile}:${c.id}`)??0.5};if(['button','toggle','key'].includes(c.type)&&!get('layout-edit').checked)operate(c,latching()?Number(knownValues.get(key(c))!==1):1);});
    g.on('pointermove',function(event){if(!drag)return;const p=point(event);if(get('layout-edit').checked){c.x+=p.x-drag.x;c.y+=p.y-drag.y;c.x=Math.max(30,Math.min(940,c.x));c.y=Math.max(60,Math.min(sceneHeight-(c.type==='key'?(c.height??90)+30:(c.radius??22)+50),c.y));drag.x=p.x;drag.y=p.y;select(this).attr('transform',`translate(${c.x},${c.y})`);}else if(['knob','slider'].includes(c.type)){const fraction=c.type==='slider'?(c.horizontal?(p.x-c.x)/(c.width??140)+0.5:0.5-(p.y-c.y)/(c.height??120)):drag.value+(drag.y-p.y)/160;operate(c,fraction);}});
    g.on('pointerup pointercancel',()=>{if(drag&&!get('layout-edit').checked&&['button','toggle','key'].includes(c.type)&&!latching())operate(c,0);drag=null;});
    g.on('keydown',event=>{if(['ArrowLeft','ArrowDown','ArrowRight','ArrowUp','Home','End',' ','Enter'].includes(event.key)){event.preventDefault();if(event.repeat&&[' ','Enter'].includes(event.key))return;choose(c);if(c.type==='key'&&![' ','Enter'].includes(event.key)){const keys=profiles[profile].controls.filter(k=>k.type==='key'),note=event.key==='Home'?Math.min(...keys.map(k=>k.note??60)):event.key==='End'?Math.max(...keys.map(k=>k.note??60)):(c.note??60)+(['ArrowRight','ArrowUp'].includes(event.key)?1:-1);const next=keys.find(k=>k.note===note);if(next)svg.select(`[data-control="${next.id}"]`).node().focus();return;}const old=controlValues.get(`${profile}:${c.id}`)??0.5;if([' ','Enter'].includes(event.key))operate(c,latching()?Number(knownValues.get(key(c))!==1):1);else operate(c,event.key==='Home'?0:event.key==='End'?1:old+(['ArrowRight','ArrowUp'].includes(event.key)?1:-1)*(event.shiftKey?0.1:1/127));}});
    g.on('keyup',event=>{if([' ','Enter'].includes(event.key)&&['button','toggle','key'].includes(c.type)&&!latching()){event.preventDefault();operate(c,0);}});
  }
  choose(p.controls[0]);updateDrawing();
}
function point(event){const p=get('device-drawing').createSVGPoint();p.x=event.clientX;p.y=event.clientY;return p.matrixTransform(get('device-drawing').getScreenCTM().inverse());}
function updateDrawing(){
  svg.selectAll('.device-control').each(function(c){
    const g=select(this), id=key(c), v=controlValues.get(`${profile}:${c.id}`)??0.5,b=bindings.get(id), result=values.get(id);
    g.classed('selected',selected?.id===c.id).classed('unknown',result===null).classed('active',c.type==='key'?v===1:b?.output==='binary'&&result===1).attr('aria-valuenow',Math.round(v*127));
    if(['button','toggle','key'].includes(c.type))g.attr('aria-pressed',String(c.type==='key'?v===1:result===1));
    if(c.type==='knob'){g.select('.needle').attr('transform',`rotate(${scaleLinear().domain([0,1]).range([-135,135])(v)})`);g.select('.control-value').text(typeof result==='number'?result.toFixed(2):'↕');}
    if(c.type==='slider'){const w=c.horizontal?c.width??140:20,h=c.horizontal?20:c.height??120;g.select('.slider-thumb').attr('x',c.horizontal?-w/2+v*w-8:-19).attr('y',c.horizontal?-19:h/2-v*h-8);}
  });
}
get('controller-profile').addEventListener('change',()=>{profile=get('controller-profile').value;if(profile==='umx'&&navigator.maxTouchPoints>0){get('controller-zoom').value=3;get('device-drawing').style.width='3000px';}drawDevice();});
get('controller-zoom').addEventListener('input',()=>{get('device-drawing').style.width=`${1000*Number(get('controller-zoom').value)}px`;});

const oscControls=new Map();
function makeOscillators(){
  for(const o of bank.oscillators){
    const section=document.createElement('section');section.className='oscillator-strip';section.dataset.oscillator=o.id;
    const h=document.createElement('h3');h.textContent=`Oscillator ${o.id}`;const enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=o.enabled;enabled.setAttribute('aria-label',`Enable oscillator ${o.id}`);h.append(enabled);section.append(h);
    const shape=document.createElement('select');for(const kind of ['sine','square','saw','triangle','noise']){const option=document.createElement('option');option.value=kind;option.textContent=kind;shape.append(option);}shape.value=o.shape;shape.setAttribute('aria-label',`Oscillator ${o.id} waveform`);section.append(shape);
    const gate=document.createElement('input');gate.type='checkbox';gate.checked=o.gate;gate.setAttribute('aria-label',`Oscillator ${o.id} gate`);const gateLabel=document.createElement('label');gateLabel.append('Gate',gate);section.append(gateLabel);
    gate.addEventListener('change',()=>{bank.set(o.id,'gate',gate.checked);renderFrame();});
    const controls={enabled,shape,gate};
    for(const [parameter,max] of [['frequency',1],['amplitude',1],['phase',1],['duty',1]]){
      const label=document.createElement('label'),input=document.createElement('input'),output=document.createElement('output');input.type='range';input.min=0;input.max=max;input.step=0.001;input.setAttribute('aria-label',`Oscillator ${o.id} ${parameter}`);label.append(parameter,input,output);section.append(label);controls[parameter]={input,output};
      input.addEventListener('input',()=>{guided=false;const v=Number(input.value);bank.set(o.id,parameter,parameter==='frequency'?scaleLog().domain([1,7000]).range([0,1]).invert(v):parameter==='duty'?0.01+0.98*v:v);renderFrame();});
    }
    enabled.addEventListener('change',()=>{bank.set(o.id,'enabled',enabled.checked);renderFrame();});shape.addEventListener('change',()=>{bank.set(o.id,'shape',shape.value);renderFrame();});
    get('oscillator-bank').append(section);oscControls.set(o.id,controls);
  }
  syncOscillatorControls();
}
function syncOscillatorControls(){get('oscillator-summary').textContent=bank.oscillators.filter(o=>o.enabled).map(o=>`${o.id}: ${o.shape} · ${o.frequency.toFixed(0)} Hz · amplitude ${o.amplitude.toFixed(2)} · gate ${o.gate?'on':'off'}`).join(' | ')||'All virtual sources disabled';for(const o of bank.oscillators){const c=oscControls.get(o.id);if(!c)continue;c.enabled.checked=o.enabled;c.gate.checked=o.gate;c.shape.value=o.shape;for(const p of ['frequency','amplitude','phase','duty']){c[p].input.value=p==='frequency'?scaleLog().domain([1,7000]).range([0,1])(o[p]):p==='duty'?(o[p]-0.01)/0.98:o[p];c[p].output.textContent=p==='frequency'?`${o[p].toFixed(0)} Hz`:o[p].toFixed(2);}}}
const plot=new uPlot({width:Math.max(300,get('virtual-plot').clientWidth),height:240,title:'Virtual waveform · drag to zoom; double-click resets',cursor:{drag:{x:true,y:false,setScale:true}},scales:{x:{time:false},y:{range:()=>[-1.2,1.2]}},axes:[{stroke:'#b7bbad',grid:{stroke:'#3b4039'},values:(u,values)=>values.map(v=>`${(v*1000).toFixed(0)} ms`)},{stroke:'#b7bbad',grid:{stroke:'#3b4039'}}],series:[{},...['A','B','C','D','Mix'].map((label,i)=>({label,stroke:['#ffb366','#b4cf89','#9aadc9','#cc9bb8','#eeecdf'][i],width:i===4?2:1}))],hooks:{setCursor:[u=>{if(Number.isInteger(u.cursor.idx))get('virtual-inspection').textContent=`${(u.cursor.idx/frame.sampleRate*1000).toFixed(3)} ms · mix ${frame.mix[u.cursor.idx].toFixed(4)} · sample ${u.cursor.idx}`;}]}},[],get('virtual-plot'));
new ResizeObserver(()=>plot.setSize({width:Math.max(280,get('virtual-plot').clientWidth),height:240})).observe(get('virtual-plot'));
plot.over.tabIndex=0;plot.over.setAttribute('role','img');plot.over.setAttribute('aria-label','Virtual waveform. Arrow keys inspect samples; Home and End reach the capture edges.');
plot.over.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const n=frame.mix.length,index=Math.max(0,Math.min(n-1,event.key==='Home'?0:event.key==='End'?n-1:(plot.cursor.idx??0)+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?10:1)));plot.setCursor({left:Math.max(0,Math.min(plot.over.clientWidth-0.1,plot.valToPos(index/frame.sampleRate,'x'))),top:plot.over.clientHeight/2});get('virtual-inspection').textContent=`${(index/frame.sampleRate*1000).toFixed(3)} ms · mix ${frame.mix[index].toFixed(4)} · sample ${index}`;}});
let previewQueued=false;
function requestPreview(){if(!running&&!previewQueued){previewQueued=true;requestAnimationFrame(()=>{previewQueued=false;renderFrame();});}}
let plotReady=false;
function renderFrame(){frame=bank.render();const x=Float64Array.from(frame.mix,(_,i)=>i/frame.sampleRate);plot.setData([x,...frame.traces,frame.mix],!plotReady);plotReady=true;const peak=frame.mix.reduce((m,v)=>Math.max(m,Math.abs(v)),1);plot.setScale('y',{min:-Math.max(1.2,peak*1.1),max:Math.max(1.2,peak*1.1)});syncOscillatorControls();updateDrawing();if(virtualLinked)emitVirtualFrame();}
function animate(now){get('controller-demo').textContent=guided?'Stop guided animation':'Guided animation';if(running&&document.visibilityState!=='hidden'&&now-lastFrame>100){lastFrame=now;if(guided){const frequency=100*10**(0.5+0.5*Math.sin(now/2000));bank.set('A','frequency',frequency);for(const c of profiles[profile].controls){const b=bindingFor(c);if(b.target==='A.frequency'&&b.range)controlValues.set(`${profile}:${c.id}`,Math.max(0,Math.min(1,Math.log(frequency/b.range[0])/Math.log(b.range[1]/b.range[0]))));}}renderFrame();}requestAnimationFrame(animate);}
get('oscillator-play').addEventListener('click',()=>{running=!running;guided=false;get('oscillator-play').textContent=running?'Pause virtual signals':'Run virtual signals';get('controller-demo').textContent='Guided animation';});
get('controller-demo').addEventListener('click',()=>{guided=!guided;running=guided;get('oscillator-play').textContent=running?'Pause virtual signals':'Run virtual signals';get('controller-demo').textContent=guided?'Stop guided animation':'Guided animation';});
get('oscillator-spectrum').addEventListener('click',()=>window.sensehubAudio?.setVirtualSamples(frame.mix,frame.sampleRate,'Virtual oscillator mix'));
function emitVirtualFrame(){const points=Array.from(frame.mix,(value,i)=>({tUs:Math.round(i*1e6/frame.sampleRate),value}));window.sensehubLab.upsertChannel('virtual-waveform',{schemaVersion:1,name:'Virtual oscillator mix',kind:'numeric',stage:'raw',unit:'relative amplitude',provenance:{sampleRateHz:frame.sampleRate,virtualStartSample:frame.startSample,clock:'virtual-frame',timestampQuantizationUs:1},data:{encoding:'edges',points,endUs:Math.round(frame.mix.length*1e6/frame.sampleRate)}});}
get('virtual-channel').addEventListener('click',()=>{virtualLinked=true;emitVirtualFrame();status('Virtual waveform linked to the channel lab; each new capture updates it. Timestamps are rounded to ±0.5 µs.');});
get('mapped-channel').addEventListener('click',()=>{try{const id=key(selected),c=captures.get(id);if(!c)throw new Error('Operate this control first. Structured events are inspected as events, not scalar samples.');linkedCaptures.add(id);emitCapture(id,c);status('Mapped output linked to the channel lab; new input events update it and can be live-forwarded through the proxy.');}catch(error){status(error.message);}});

get('simulate-midi').addEventListener('click',()=>incoming(decodeMidi([0xb0,14,96],'simulated-midi')));
get('simulate-gpio').addEventListener('click',()=>{const event={source:'gpio',sourceId:'simulated-esp32',kind:'digital',channel:8,number:null,value:0,raw:1,max:1,tUs:Math.round(performance.now()*1000)};incoming(event);setTimeout(()=>incoming({...event,value:1,raw:0,tUs:event.tUs+20000}),20);setTimeout(()=>incoming({...event,value:0,raw:1,tUs:event.tUs+100000}),100);});
get('custom-control-form').addEventListener('submit',event=>{event.preventDefault();const list=profiles.custom.controls;if(list.length>=32){status('Custom view supports 32 controls.');return;}const type=get('custom-control-kind').value;profiles.custom.name=get('custom-device-name').value||'My device';list.push({id:`control-${list.length+1}`,label:get('custom-control-name').value||'Control',type,x:150+(list.length%5)*160,y:85+Math.floor(list.length/5)*90,...(type==='key'?{note:60,width:44,height:90}:{}),target:type==='key'?'keyboard':['button','toggle'].includes(type)?'A.gate':'A.frequency'});profile='custom';get('controller-profile').value=profile;drawDevice();choose(list.at(-1));});
get('device-photo').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>3000000){status('Choose a PNG/JPEG/WebP photo under 3 MB.');return;}const reader=new FileReader();reader.onload=()=>{profiles.custom.image=reader.result;profile='custom';get('controller-profile').value=profile;drawDevice();};reader.readAsDataURL(file);});
get('save-device-request').addEventListener('click',()=>save('sensehub-device-request.json',{kind:'sensehub-device-request',version:1,name:get('custom-device-name').value,notes:get('device-request-notes').value,controls:profiles.custom.controls}));
get('save-controls').addEventListener('click',()=>save('sensehub-control-map.json',{kind:'sensehub-controls',version:1,bindings:[...bindings.values()],custom:profiles.custom,presentation:{profile,zoom:Number(get('controller-zoom').value),hoverHints:get('controller-hover').checked}}));
get('controls-file').addEventListener('change',async event=>{try{const file=event.target.files[0];if(!file)return;if(file.size>8000000)throw new Error('Control map too large.');const value=validateControlMap(JSON.parse(await file.text()));if(value.custom)profiles.custom=value.custom;bindings.clear();values.clear();knownValues.clear();captures.clear();pressed.clear();heldNotes.clear();observedNotes.clear();bank.set('A','gate',false);value.bindings.forEach(b=>bindings.set(b.id,b));if(value.presentation){profile=value.presentation.profile??profile;get('controller-profile').value=profile;get('controller-zoom').value=value.presentation.zoom??1;get('device-drawing').style.width=`${1000*Number(get('controller-zoom').value)}px`;get('controller-hover').checked=value.presentation.hoverHints??true;}persist();drawDevice();syncOscillatorControls();status('Control map loaded. Hardware ports must be connected separately.');}catch(error){status(error.message);}});

get('connect-midi').addEventListener('click',async()=>{
  try{if(!navigator.requestMIDIAccess)throw new Error('Web MIDI unavailable here; use Chromium on localhost/HTTPS or simulated events.');midiAccess=await navigator.requestMIDIAccess({sysex:false});
    const refresh=()=>{
      const previous=get('midi-port').value,active=new Set();get('midi-port').replaceChildren(new Option('All available inputs',''));
      for(const input of midiAccess.inputs.values()){
        const option=new Option(input.name||input.id,input.id);option.disabled=input.state==='disconnected';get('midi-port').append(option);if(!option.disabled)active.add(input.id);
        input.onmidimessage=event=>{if(!get('midi-port').value||get('midi-port').value===input.id)incoming(decodeMidi(event.data,input.id));};
      }
      let removed=false;
      for(const id of knownMidiPorts)if(!active.has(id)){
        for(const key of [...heldNotes.keys()])if(key.startsWith(`${id}:`)){heldNotes.delete(key);removed=true;}
        for(const [key,note]of [...observedNotes])if(key.startsWith(`${id}:`)){observedNotes.delete(key);controlValues.set(`umx:key-${note}`,0);}
      }
      knownMidiPorts=active;if(removed)bank.set('A','gate',heldNotes.size>0);
      if(previous){if(!midiAccess.inputs.has(previous)){const option=new Option('Previous input disconnected',previous);option.disabled=true;get('midi-port').append(option);}get('midi-port').value=previous;}
      updateDrawing();syncOscillatorControls();get('hardware-status').textContent=`MIDI connected: ${active.size} input ports. Select a diagram control and Learn its next message.`;
    };refresh();midiAccess.onstatechange=refresh;
  }catch(error){get('hardware-status').textContent=error.message;}
});
const digitalBuffers=new Map(), digitalRevisions=new Map(), configuredInputs=new Map();
function acceptDigital(payload,sourceId=serialSource){
  const event=decodeDigital(payload,sourceId),id=`${sourceId}:${event.channel}`;
  if(serialPort&&sourceId===serialSource)get('hardware-status').textContent=`Receiving GPIO channel ${event.channel}: ${event.value===null?'unknown / confirming':event.value?'HIGH':'LOW'} · sequence ${event.sequence}`;
  const key=`${sourceId}:${event.channel}`;
  if(digitalRevisions.has(key)&&digitalRevisions.get(key)!==event.revision)event.gap=true;digitalRevisions.set(key,event.revision);
  let buffer=digitalBuffers.get(id);if(buffer&&(buffer.revision!==event.revision||event.tUs<=buffer.origin+(buffer.conditioned.at(-1)?.tUs??-1))){event.gap=true;buffer=null;}
  if(!buffer){buffer={revision:event.revision,origin:event.tUs,raw:[],conditioned:[],lastSeq:null};digitalBuffers.set(id,buffer);}
  if(buffer.lastSeq!==null&&event.sequence!==buffer.lastSeq+1)event.gap=true;
  incoming(event);
  const time=event.tUs-buffer.origin;if(time<0)return;
  if(buffer.conditioned.length&&(event.gap||(buffer.lastSeq!==null&&event.sequence!==buffer.lastSeq+1))&&time>buffer.conditioned.at(-1).tUs+1){const gap={tUs:buffer.conditioned.at(-1).tUs+1,value:null};buffer.raw.push(gap);buffer.conditioned.push(gap);}
  if(buffer.conditioned.length&&time<=buffer.conditioned.at(-1).tUs)return;
  buffer.raw.push({tUs:time,value:event.raw});buffer.conditioned.push({tUs:time,value:event.value});buffer.lastSeq=event.sequence;
  if(buffer.raw.length>512)buffer.raw.shift();if(buffer.conditioned.length>512)buffer.conditioned.shift();
  const channelId=gpioChannelId(sourceId,event.channel);event.channelId=channelId;
  if(!suppressedChannels.has(`${channelId}-raw`))window.sensehubLab.upsertChannel(`${channelId}-raw`,{schemaVersion:1,name:`ESP32 raw input ${event.channel} · ${sourceId.slice(-8)}`,kind:'digital',stage:'raw',unit:'logic',provenance:{sourceId,revision:event.revision,deviceTimeOriginUs:buffer.origin},data:{encoding:'edges',points:buffer.raw,endUs:time+1000}});
  if(!suppressedChannels.has(channelId))window.sensehubLab.upsertChannel(channelId,{schemaVersion:1,name:`ESP32 input ${event.channel} · ${sourceId.slice(-8)}`,kind:'digital',stage:'conditioned',unit:'logic',provenance:{sourceId,revision:event.revision,deviceTimeOriginUs:buffer.origin,rawObservations:buffer.raw},data:{encoding:'edges',points:buffer.conditioned,endUs:time+1000}});
  return event;
}
async function serialFrames(chunk){for(const f of parser.feed(chunk)){
  if(f.type===0x08){deviceCapabilities=JSON.parse(new TextDecoder().decode(f.payload));window.sensehubLab.receiveCapabilities(deviceCapabilities);if(typeof deviceCapabilities.deviceId==='string')serialSource=`esp32-${deviceCapabilities.deviceId}`;if(handshakeTimer){clearInterval(handshakeTimer);handshakeTimer=null;}get('hardware-status').textContent=`Connected ${deviceCapabilities.soc} / ${deviceCapabilities.profile}.`;}
  else if(f.type===0x09)acceptDigital(f.payload);
  else if(f.type===0x06&&f.payload[0]===0x21)get('hardware-status').textContent=f.payload[1]===0?'Button input configuration accepted. Waiting for observations.':`Button configuration rejected: code ${f.payload[1]}.`;
  else if(f.type===0x0A){const c=decodeChannelState(f.payload);configuredInputs.set(c.id,c);let control=profiles.gpio.controls.find(control=>control.channel===c.id);if(c.mode===1){if(!control){control={id:`input-${c.id}`,type:'button',x:160+(profiles.gpio.controls.length%4)*220,y:220+Math.floor(profiles.gpio.controls.length/4)*90,channel:c.id,target:'A.gate'};profiles.gpio.controls.push(control);}control.label=`GPIO ${c.pin} / channel ${c.id}`;}if(profile==='gpio')drawDevice();}
}}
async function closeSerial(){
  serialReading=false;
  if(handshakeTimer){clearInterval(handshakeTimer);handshakeTimer=null;}
  if(reader){try{await reader.cancel();}catch{/* already closed */}}
  if(serialReadFinished){try{await serialReadFinished;}catch{/* reported by reader */}serialReadFinished=null;}
  if(writer){writer.releaseLock();writer=null;}
  if(serialPort){const port=serialPort;serialPort=null;try{await port.close();}catch{/* failed-open or unplugged port */}}
}
get('connect-serial').addEventListener('click',async()=>{
  if(serialPort){get('hardware-status').textContent='Disconnect the current serial port first.';return;}
  try{if(!navigator.serial)throw new Error('Web Serial unavailable; use Chromium on localhost/HTTPS or a host adapter.');serialPort=await navigator.serial.requestPort();await serialPort.open({baudRate:115200});parser.buffer=new Uint8Array();deviceCapabilities=null;serialSource=`serial-${serialPort.getInfo().usbVendorId??'port'}-${serialPort.getInfo().usbProductId??''}`;writer=serialPort.writable.getWriter();serialReading=true;reader=serialPort.readable.getReader();
    serialReadFinished=(async()=>{try{while(serialReading){const {value,done}=await reader.read();if(done)break;await serialFrames(value);}}finally{reader.releaseLock();reader=null;}})();
    let attempts=0;const handshake=async()=>{if(!writer||deviceCapabilities)return;try{await writer.write(new TextEncoder().encode('MODE USB\n'));await writer.write(encodeFrame(0x20));if(++attempts>=12&&!deviceCapabilities){clearInterval(handshakeTimer);handshakeTimer=null;get('hardware-status').textContent='Serial open, no SenseHub capabilities yet. Check firmware, run-mode jumper and baud rate.';}}catch(error){get('hardware-status').textContent=error.message;}};
    get('hardware-status').textContent='Serial open; waiting for SenseHub firmware and capabilities.';handshakeTimer=setInterval(handshake,750);await handshake();
    await serialReadFinished;
  }catch(error){get('hardware-status').textContent=error.message;serialReadFinished=null;await closeSerial();}
  finally{if(serialReading){serialReading=false;serialReadFinished=null;await closeSerial();}}
});
get('disconnect-serial').addEventListener('click',async()=>{await closeSerial();get('hardware-status').textContent='Serial disconnected; imported captures retained.';});
get('gpio-button-form').addEventListener('submit',async event=>{
  event.preventDefault();try{const id=Number(get('button-channel').value),pin=Number(get('button-pin').value),pull=Number(get('button-pull').value),invert=get('button-invert').checked,debounceMs=Number(get('button-debounce').value);
    if(writer&&!deviceCapabilities)throw new Error('Wait for the board capability reply before configuring inputs.');
    if(deviceCapabilities&&(!deviceCapabilities.availablePins.includes(pin)||!deviceCapabilities.channelIds.includes(id)||(pull&&deviceCapabilities.noPullPins.includes(pin))))throw new Error('Pin/channel/pull is not advertised by the connected device.');
    const config={id,pin,pull,invert,debounceMs,pollMs:10},request=encodeChannelConfig(config);get('gpio-request').textContent=`CHANNEL ${id} 1 ${pin} ${pull} ${Number(invert)} 10 ${debounceMs} 0 0 0\n${JSON.stringify(config)}`;
    if(writer){get('hardware-status').textContent='Button configuration sent; waiting for ACK.';await writer.write(request);}else get('hardware-status').textContent='Button request prepared. Connect ESP32 serial to send it.';
  }catch(error){get('hardware-status').textContent=error.message;}
});
get('usbip-form').addEventListener('submit',event=>{event.preventDefault();try{get('usbip-commands').textContent=usbIpCommands(get('usbip-host').value,get('usbip-bus').value,get('usbip-ssh').value).join('\n');}catch(error){get('usbip-commands').textContent=error.message;}});
for(const label of get('controller-workbench').querySelectorAll('.file')){label.tabIndex=0;label.setAttribute('role','button');label.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();label.querySelector('input').click();}});}
window.sensehubControls=Object.freeze({receiveMidi:(bytes,sourceId)=>incoming(decodeMidi(bytes,sourceId)),receiveDigital:acceptDigital,bank,bindings:()=>[...bindings.values()],events:()=>[...eventLog],plotState:()=>({x:{min:plot.scales.x.min,max:plot.scales.x.max},y:{min:plot.scales.y.min,max:plot.scales.y.max},samples:bank.sampleCount,running,guided}),selectControl:id=>{const c=profiles[profile].controls.find(c=>c.id===id);if(!c)throw new Error('Unknown control.');choose(c);}});
makeOscillators();drawDevice();renderFrame();requestAnimationFrame(animate);
