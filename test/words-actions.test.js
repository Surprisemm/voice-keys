'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, validateConfig, WordCommandMatcher, createMatcher } = require('../src/core');
const { createKeyController } = require('../src/key-controller');

test('word mode executes first and second as separate actions without a final phrase', () => {
  let time = 0; const matcher = new WordCommandMatcher(DEFAULTS.mappings, 'ru', { now: () => time, wordStabilityMs: 100 });
  assert.equal(matcher.assess('первый второй').actions.length, 0);
  time = 100; assert.deepEqual(matcher.assess('первый второй').actions.map(action => action.key), ['Q','W']);
  assert.deepEqual(matcher.assess('первый второй').actions, []);
  assert.deepEqual(matcher.assess('первый второй', true).actions, []);
});
test('new words are appended once and repeated words are separate occurrences', () => {
  let time = 0; const matcher = new WordCommandMatcher(DEFAULTS.mappings, 'ru', { now: () => time, wordStabilityMs: 50 });
  matcher.assess('первый'); time = 60; assert.equal(matcher.assess('первый').actions.length, 1);
  matcher.assess('первый первый'); time = 120; assert.equal(matcher.assess('первый первый').actions.length, 1);
  assert.equal(matcher.assess('первый первый', true).actions.length, 0);
});
test('revisions do not block new commands and do not replay the same occurrence', () => {
  let time = 0; const matcher = new WordCommandMatcher(DEFAULTS.mappings, 'ru', { now: () => time });
  matcher.assess('первый'); time = 50; matcher.assess('второй'); time = 160;
  assert.equal(matcher.assess('второй').actions[0].key, 'W');
  assert.equal(matcher.assess('первый второй').reason, 'partial');
  assert.deepEqual(matcher.assess('первый второй', true).actions.map(action=>action.key), ['Q']);
});
test('word mode ignores multiword assignments and unknown words', () => {
  const matcher = new WordCommandMatcher([{phrase:'первый второй', key:'R', language:'ru'}, {phrase:'первый',key:'Q',language:'ru'}], 'ru');
  assert.deepEqual(matcher.assess('привет первый второй', true).actions.map(action => action.key), ['Q']);
});
test('an incomplete unknown suffix stays editable until it becomes a command word', () => {
  let now=0;const matcher=new WordCommandMatcher(DEFAULTS.mappings,'ru',{now:()=>now});
  matcher.assess('перв');now=200;assert.deepEqual(matcher.assess('перв').actions,[]);
  matcher.assess('первый');now=310;assert.equal(matcher.assess('первый').actions[0].key,'Q');
});
test('word mode accepts commands inside speech only when that mode is selected', () => {
  const words = createMatcher({ ...DEFAULTS, commandMode: 'words' });
  assert.equal(words.assess('это первый тест', true).actions[0].key, 'Q');
  const phrase = createMatcher({ ...DEFAULTS, commandMode: 'phrase' });
  assert.equal(phrase.assess('это первый тест', true).accepted, false);
});
test('tap and hold on the same key remain distinct configured actions', () => {
  const config = validateConfig({ ...DEFAULTS, mappings: [{ phrase:'удар',language:'ru',key:'Q',actionType:'tap'}, {phrase:'хэви',language:'ru',key:'Q',actionType:'hold',durationMs:1000}] });
  const matcher = createMatcher({ ...config, commandMode:'words' });
  const actions = matcher.assess('удар хэви', true).actions;
  assert.deepEqual(actions.map(action => [action.key, action.actionType, action.durationMs]), [['Q','tap',65],['Q','hold',1000]]);
});
test('invalid actions and unreasonable holds are rejected', () => {
  for (const mapping of [{actionType:'macro'}, {actionType:'hold',durationMs:0}, {actionType:'hold',durationMs:10001}, {actionType:'hold',durationMs:20.5}]) {
    assert.throws(() => validateConfig({ ...DEFAULTS, mappings:[{phrase:'удар',key:'Q',language:'ru',...mapping}] }));
  }
});
test('legacy settings preserve phrase/Vosk mode and become short taps', () => {
  const legacy = structuredClone(DEFAULTS); delete legacy.modelId; delete legacy.commandMode;
  const config = validateConfig(legacy); assert.equal(config.modelId,'vosk'); assert.equal(config.commandMode,'phrase'); assert.equal(config.mappings[0].durationMs,65);
});
test('Sherpa phrase results explicitly carry no confidence while exact matching remains', () => {
  const matcher = createMatcher({ ...DEFAULTS, modelId:'sherpa', commandMode:'phrase' });
  assert.equal(matcher.assess('первый',true).action.confidence,null);
  assert.equal(matcher.assess('первый день',true).accepted,false);
});

function controller(t, overrides = {}) {
  t.mock.timers.enable({ apis:['setTimeout','Date'], now:1000 });
  const events = [];
  const input = createKeyController({ down:key => (events.push(['down',key,Date.now()]),true), up:key => (events.push(['up',key,Date.now()]),true), isDown:()=>false, modifiersDown:()=>false, ...overrides }, { now: Date.now });
  return { input, events };
}
test('held key is released after the specified milliseconds', async t => {
  const {input, events} = controller(t); const result = input.perform({key:'Q',durationMs:1000});
  t.mock.timers.tick(999); assert.deepEqual(input.activeKeys(),['Q']); t.mock.timers.tick(1);
  assert.equal((await result).actualDurationMs,1000); assert.deepEqual(events,[['down','Q',1000],['up','Q',2000]]);
});
test('tap then hold on the same key is serialized without losing either action', async t => {
  const {input,events} = controller(t); const first = input.perform({key:'Q',durationMs:65}), second=input.perform({key:'Q',durationMs:1000});
  t.mock.timers.tick(65); await first; assert.equal(events.length,3); t.mock.timers.tick(1000); await second;
  assert.deepEqual(events.map(event=>event.slice(0,2)),[['down','Q'],['up','Q'],['down','Q'],['up','Q']]);
});
test('another key can press while the first key is held', async t => {
  const {input,events} = controller(t); const hold = input.perform({key:'Q',durationMs:1000}), tap=input.perform({key:'W',durationMs:65});
  t.mock.timers.tick(65); await tap; assert.deepEqual(input.activeKeys(),['Q']); t.mock.timers.tick(935); await hold;
  assert.deepEqual(events.map(event=>event.slice(0,2)),[['down','Q'],['down','W'],['up','W'],['up','Q']]);
});
test('emergency stop releases all keys and cancels waiting commands', async t => {
  const {input,events} = controller(t); const one=input.perform({key:'Q',durationMs:1000}), two=input.perform({key:'W',durationMs:1000}), queued=input.perform({key:'Q',durationMs:500});
  t.mock.timers.tick(120); input.cancelAll(); assert.deepEqual(input.activeKeys(),[]);
  assert.equal((await one).cancelled,true); assert.equal((await two).actualDurationMs,120); assert.equal((await queued).cancelled,true);
  t.mock.timers.tick(2000); assert.equal(events.filter(event=>event[0]==='down').length,2);
});
test('manual modifiers defer a command until released instead of discarding it', async t => {
  let held=true;const {input,events}=controller(t,{modifiersDown:()=>held});const result=input.perform({key:'Q',durationMs:65});assert.deepEqual(events,[]);held=false;t.mock.timers.tick(20);assert.equal(events[0][0],'down');t.mock.timers.tick(65);assert.equal((await result).ok,true);
});
