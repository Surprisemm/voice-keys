'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DEFAULTS,WordCommandMatcher,validateConfig}=require('../src/core');
const {validateStore,changeProfile}=require('../src/profiles');
const {ActionTimeline,overlayBounds}=require('../src/overlay');
const {createKeyController}=require('../src/key-controller');
const {createSampleStore}=require('../src/samples');

test('three repeated recognized words produce three actions despite earlier text revision',()=>{
  let time=0;const matcher=new WordCommandMatcher(DEFAULTS.mappings,'ru',{now:()=>time});matcher.assess('первый');time=110;assert.equal(matcher.assess('первый').actions.length,1);
  matcher.assess('первый день');time=220;matcher.assess('первый первый');time=330;assert.equal(matcher.assess('первый первый').actions.length,1);
  matcher.assess('первый первый первый второй');time=440;assert.deepEqual(matcher.assess('первый первый первый второй').actions.map(x=>x.key),['Q','W']);assert.deepEqual(matcher.assess('первый первый первый второй',true).actions,[]);
});
test('shrinking and reappearing partial text does not replay an already executed word',()=>{
  const matcher=new WordCommandMatcher(DEFAULTS.mappings,'ru',{wordStabilityMs:0});assert.equal(matcher.assess('первый').actions.length,1);matcher.assess('');assert.equal(matcher.assess('первый').actions.length,0);assert.equal(matcher.assess('первый первый').actions.length,1);
});
test('English repeated letter aliases count each occurrence independently',()=>{
  const matcher=new WordCommandMatcher(DEFAULTS.mappings,'en');assert.deepEqual(matcher.assess('q queue q',true).actions.map(action=>action.key),['Q','Q','Q']);
});
test('an earlier unknown-word revision cannot block a later configured command',()=>{
  let time=0;const matcher=new WordCommandMatcher(DEFAULTS.mappings,'ru',{now:()=>time});matcher.assess('перв');time=120;matcher.assess('перв');matcher.assess('другой первый');time=240;assert.equal(matcher.assess('другой первый').actions[0].key,'Q');
});
test('twenty repeated words are queued without the former sixteen-request limit',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});const edges=[];const input=createKeyController({down:key=>(edges.push(['down',key]),true),up:key=>(edges.push(['up',key]),true),isDown:()=>false,modifiersDown:()=>false},{now:Date.now});
  const results=Array.from({length:20},()=>input.perform({key:'Q',durationMs:20}));for(let i=0;i<20;i++)t.mock.timers.tick(20);assert((await Promise.all(results)).every(x=>x.ok));assert.equal(edges.length,40);
});
test('queue preserves Q Q W order and leaves a gap between repeated key presses',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});const edges=[];const input=createKeyController({down:key=>(edges.push(['down',key,Date.now()]),true),up:key=>(edges.push(['up',key,Date.now()]),true),isDown:()=>false,modifiersDown:()=>false},{now:Date.now,gapMs:80,releaseGapMs:20});
  const done=[input.perform({key:'Q',durationMs:65}),input.perform({key:'Q',durationMs:65}),input.perform({key:'W',durationMs:65})];t.mock.timers.tick(65);t.mock.timers.tick(20);t.mock.timers.tick(65);t.mock.timers.tick(15);t.mock.timers.tick(65);await Promise.all(done);
  assert.deepEqual(edges.filter(x=>x[0]==='down').map(x=>x.slice(1)),[['Q',0],['Q',85],['W',165]]);
});
test('manually held target key waits and survives until it is released',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});let held=true,pressed=0;const input=createKeyController({down:()=>{pressed++;return true;},up:()=>true,isDown:()=>held,modifiersDown:()=>false},{now:Date.now});const done=input.perform({key:'Q',durationMs:20});t.mock.timers.tick(200);assert.equal(pressed,0);held=false;t.mock.timers.tick(20);t.mock.timers.tick(20);assert.equal((await done).ok,true);
});
test('profile migration keeps legacy commands and creates a named default profile',()=>{
  const store=validateStore(DEFAULTS);assert.equal(store.profiles.length,1);assert.equal(store.profiles[0].name,'Общий');assert.deepEqual(store.mappings.map(x=>x.phrase),DEFAULTS.mappings.map(x=>x.phrase));
});
test('new profiles can start empty and switching restores separate command sets',()=>{
  let store=validateStore(DEFAULTS);const original=store.activeProfileId;store=changeProfile(store,{operation:'create',name:'Deadlock'});const second=store.activeProfileId;assert.deepEqual(store.mappings,[]);
  store=validateStore({...store,mappings:[{phrase:'удар',key:'T',language:'ru'}]});store=changeProfile(store,{operation:'switch',id:original});assert.equal(store.mappings[0].key,'Q');store=changeProfile(store,{operation:'switch',id:second});assert.equal(store.mappings[0].key,'T');
});
test('profile copy, rename, deletion and global settings survive a round trip',()=>{
  let store=validateStore({...DEFAULTS,microphoneId:'test-mic',queueGapMs:120});store=changeProfile(store,{operation:'create',name:'Dota',copy:true});assert.equal(store.mappings.length,DEFAULTS.mappings.length);store=changeProfile(store,{operation:'rename',id:store.activeProfileId,name:'Dota 2'});assert.equal(store.microphoneId,'test-mic');store=changeProfile(store,{operation:'delete',id:store.activeProfileId});assert.equal(store.profiles.length,1);assert.equal(store.queueGapMs,120);assert.throws(()=>changeProfile(store,{operation:'delete',id:store.activeProfileId}));assert.deepEqual(validateStore(JSON.parse(JSON.stringify(store))),store);
});
test('duplicate profile names are rejected without losing a profile',()=>{const store=validateStore(DEFAULTS);assert.throws(()=>changeProfile(store,{operation:'create',name:'Общий'}));assert.equal(store.profiles.length,1);});
test('overlay retains pending commands, dims executed ones and expires only finished entries',()=>{
  let now=0;const timeline=new ActionTimeline({now:()=>now,retentionMs:()=>500});timeline.enqueue({actionId:1,key:'Q'});timeline.enqueue({actionId:2,key:'Q'});timeline.start(1);assert.deepEqual(timeline.snapshot().map(x=>x.status),['done','pending']);now=10000;assert.equal(timeline.snapshot().length,2);timeline.finish(1,{ok:true});now+=500;assert.deepEqual(timeline.snapshot().map(x=>x.actionId),[2]);timeline.cancel();assert.equal(timeline.snapshot()[0].status,'cancelled');
});
test('overlay bounds fit horizontal and vertical strips on monitors with negative origins',()=>{const area={x:-1920,y:0,width:1920,height:1080};for(const orientation of ['horizontal','vertical']){const bounds=overlayBounds({...DEFAULTS.overlay,orientation,offsetX:9999,offsetY:-9999},area,100);assert(bounds.x>=area.x&&bounds.x+bounds.width<=area.x+area.width);assert(bounds.y>=area.y&&bounds.y+bounds.height<=area.y+area.height);}});
test('overlay and queue settings are validated with useful legacy defaults',()=>{const value=validateConfig({...DEFAULTS,queueGapMs:-1,overlay:{size:999,retentionMs:0}});assert.equal(value.queueGapMs,80);assert.equal(value.overlay.size,44);assert.equal(value.overlay.retentionMs,2500);});
test('voice samples round-trip local WAV, isolate profiles and reject invalid data',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-keys-samples-'));t.after(()=>{const resolved=fs.realpathSync(dir),parent=fs.realpathSync(os.tmpdir());assert.equal(path.dirname(resolved).toLowerCase(),parent.toLowerCase());assert(path.basename(resolved).startsWith('voice-keys-samples-'));fs.rmSync(resolved,{recursive:true,force:true});});const store=createSampleStore(dir);const samples=Float32Array.from({length:8000},(_,i)=>Math.sin(i/10)*.5);const meta=store.save({profileId:'profile-a',expectedText:'первый первый',sampleRate:8000,samples});assert.equal(store.list('profile-b').length,0);assert.equal(store.list('profile-a').length,1);const loaded=store.read(meta.id,'profile-a');assert(Math.abs(loaded.samples[100]-samples[100])<.0001);assert.throws(()=>store.read(meta.id,'profile-b'));assert.throws(()=>store.read('../escape','profile-a'));assert.throws(()=>store.save({profileId:'x',expectedText:'x',sampleRate:8000,samples:new Float32Array([NaN])}));store.remove(meta.id,'profile-a');assert.equal(store.list('profile-a').length,0);
});
