'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig, DEFAULTS, buildAction, WordCommandMatcher } = require('../src/core');
const { createKeyController } = require('../src/key-controller');
const { signature } = require('../src/classifier/arbiter');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function rig() {
  const events = [], down = new Set();
  const input = createKeyController({ down: key => (down.add(key), events.push(['down', key]), true), up: key => (down.delete(key), events.push(['up', key]), true), isDown: key => down.has(key), modifiersDown: () => false });
  return { input, events, down };
}
const toggle = (key, modifiers = []) => ({ key, modifiers, durationMs: 65, actionType: 'toggle' });

test('a toggle command holds the key until it is said again', async () => {
  const { input, events, down } = rig(); let started = 0;
  const first = input.perform(toggle('1'), () => started++);
  await pause(300);
  assert.equal(started, 1); assert.ok(down.has('1')); assert.deepEqual(input.activeKeys(), ['1']);
  const second = await input.perform(toggle('1'));
  assert.equal(second.toggledOff, true); assert.equal(second.ok, true);
  const firstResult = await first;
  assert.equal(firstResult.ok, true); assert.equal(firstResult.manual, false);
  assert.deepEqual(events, [['down', '1'], ['up', '1']]);
  assert.deepEqual(input.activeKeys(), []);
});
test('pressing the toggled key yourself lifts it', async () => {
  const { input, down } = rig();
  const result = input.perform(toggle('1'));
  await pause(300);
  down.delete('1'); // the user pressed and released the key: Windows reports it as up
  const finished = await Promise.race([result, pause(1000).then(() => 'stuck')]);
  assert.notEqual(finished, 'stuck'); assert.equal(finished.manual, true); assert.deepEqual(input.activeKeys(), []);
});
test('other keys work while a key is toggled, and cancelAll lifts the toggle', async () => {
  const { input, events } = rig();
  const held = input.perform(toggle('1'));
  const tap = await input.perform({ key: 'Q', modifiers: [], durationMs: 20 });
  assert.equal(tap.ok, true);
  assert.deepEqual(input.activeKeys(), ['1']);
  input.cancelAll();
  assert.equal((await held).cancelled, true);
  assert.ok(events.some(event => event[0] === 'up' && event[1] === '1'));
});
test('the toggle type is validated, kept by buildAction and distinct for deduplication', () => {
  const mapping = { id: 'a', phrase: 'первый', key: '1', language: 'ru', actionType: 'toggle', durationMs: 1000 };
  const config = validateConfig({ ...DEFAULTS, mappings: [mapping] });
  assert.equal(config.mappings[0].actionType, 'toggle'); assert.equal(config.mappings[0].durationMs, 65);
  const action = buildAction(config.mappings[0], {});
  assert.equal(action.actionType, 'toggle');
  assert.notEqual(signature(action), signature({ ...action, actionType: 'tap' }));
  assert.throws(() => validateConfig({ ...DEFAULTS, mappings: [{ ...mapping, actionType: 'flip' }] }));
  const matcher = new WordCommandMatcher(config.mappings, 'ru', { wordStabilityMs: 0 });
  assert.equal(matcher.assess('первый', true).actions[0].actionType, 'toggle');
});

test('neural words are kept per command, cleaned, and a command may have only neural words', () => {
  const config = validateConfig({ ...DEFAULTS, mappings: [{ id: 'a', phrases: ['текст'], trainedWords: ['Первый', 'первый', 'Ё-ё', ' '], key: '1', language: 'ru' }, { id: 'b', phrases: [], trainedWords: ['удар'], key: 'Q', language: 'ru' }] });
  assert.deepEqual(config.mappings[0].trainedWords, ['первый', 'е-е']); assert.deepEqual(config.mappings[0].phrases, ['текст']);
  assert.deepEqual(config.mappings[1].phrases, []); assert.equal(config.mappings[1].phrase, 'удар');
  assert.throws(() => validateConfig({ ...DEFAULTS, mappings: [{ id: 'c', phrases: [], key: 'Q', language: 'ru' }] }), /нужна фраза/);
  const text = () => new WordCommandMatcher(config.mappings, 'ru', { wordStabilityMs: 0 });
  assert.deepEqual(text().assess('первый', true).actions, [], 'neural words are not text phrases');
  assert.equal(text().assess('текст', true).actions[0].key, '1');
});
