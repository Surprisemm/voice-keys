'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WordCommandMatcher, createMatcher, validateConfig, DEFAULTS } = require('../src/core');
const { validateStore } = require('../src/profiles');

const row = (id, phrases, key) => ({ id, phrase: phrases[0], phrases, language: 'ru', key, actionType: 'tap', durationMs: 65 });
function make(words, options = {}) {
  let time = 0;
  const matcher = new WordCommandMatcher(words.map(([phrases, key], index) => row(`m${index}`, phrases, key)), 'ru', { now: () => time, wordStabilityMs: 0, prefixChars: 2, ...options });
  return { matcher, at: value => { time = value; }, keys: result => result.actions.map(action => action.key) };
}

test('unique start fires before the word is finished', () => {
  const { matcher, keys } = make([[['песня'], 'Q'], [['лето'], 'W'], [['комар'], 'E']]);
  assert.deepEqual(keys(matcher.assess('п')), []);
  const result = matcher.assess('пе');
  assert.deepEqual(keys(result), ['Q']);
  assert.equal(result.actions[0].byPrefix, true);
  assert.deepEqual(keys(matcher.assess('песня')), [], 'the full word does not press the key a second time');
  assert.deepEqual(keys(matcher.assess('песня', true)), []);
});

test('shared start waits for the letter that tells the words apart', () => {
  const { matcher, keys } = make([[['песня'], 'Q'], [['лето'], 'W'], [['легко'], 'E']]);
  assert.deepEqual(keys(matcher.assess('ле')), [], 'ле starts both лето and легко');
  assert.deepEqual(keys(matcher.assess('лет')), ['W']);
  const other = make([[['лето'], 'W'], [['легко'], 'E']]).matcher;
  assert.deepEqual(other.assess('ле').actions, []);
  assert.deepEqual(other.assess('лег').actions.map(action => action.key), ['E']);
});

test('words that start differently are told apart by their first letters', () => {
  const { matcher, keys } = make([[['лето'], 'W'], [['лимонад'], 'R']]);
  assert.deepEqual(keys(matcher.assess('л')), []);
  assert.deepEqual(keys(matcher.assess('ли')), ['R']);
});

test('a full command that is also the start of another command waits, then loses to the longer word', () => {
  const { matcher, at, keys } = make([[['лет'], 'Q'], [['лето'], 'W']], { ambiguousWaitMs: 150 });
  at(0); assert.deepEqual(keys(matcher.assess('лет')), []);
  at(100); assert.deepEqual(keys(matcher.assess('лет')), [], 'still waiting');
  at(120); assert.deepEqual(keys(matcher.assess('лето')), ['W']);
  assert.deepEqual(keys(matcher.assess('лето', true)), []);
});

test('a full command that is also the start of another command fires after the wait or at the end of the utterance', () => {
  let made = make([[['лет'], 'Q'], [['лето'], 'W']], { ambiguousWaitMs: 150 });
  made.at(0); made.matcher.assess('лет'); made.at(160);
  assert.deepEqual(made.keys(made.matcher.assess('лет')), ['Q']);
  made = make([[['лет'], 'Q'], [['лето'], 'W']], { ambiguousWaitMs: 150 });
  made.at(0); assert.deepEqual(made.keys(made.matcher.assess('лет')), []);
  made.at(10); assert.deepEqual(made.keys(made.matcher.assess('лет', true)), ['Q']);
});

test('variants of one action never make each other ambiguous', () => {
  const { matcher, keys } = make([[['кью', 'кьюб'], 'Q'], [['лето'], 'W']]);
  assert.deepEqual(keys(matcher.assess('кью')), ['Q']);
});

test('minimum letters is respected', () => {
  const { matcher, keys } = make([[['песня'], 'Q']], { prefixChars: 3 });
  assert.deepEqual(keys(matcher.assess('пе')), []);
  assert.deepEqual(keys(matcher.assess('пес')), ['Q']);
});

test('prefix mode off keeps whole-word behaviour', () => {
  const { matcher, keys } = make([[['песня'], 'Q']], { prefixChars: 0 });
  assert.deepEqual(keys(matcher.assess('пес')), []);
  assert.deepEqual(keys(matcher.assess('песня')), ['Q']);
});

test('repeated command by prefix counts every repetition once', () => {
  const { matcher, keys } = make([[['песня'], 'Q'], [['лето'], 'W']]);
  assert.deepEqual(keys(matcher.assess('песня')), ['Q']);
  assert.deepEqual(keys(matcher.assess('песня пе')), ['Q']);
  assert.deepEqual(keys(matcher.assess('песня песня')), []);
  assert.deepEqual(keys(matcher.assess('песня песня', true)), []);
});

test('a word that only looks like a start of a command does not fire', () => {
  const { matcher, keys } = make([[['песня'], 'Q']]);
  assert.deepEqual(keys(matcher.assess('первый')), []);
  assert.deepEqual(keys(matcher.assess('пес', true)), [], 'a finished word must match completely');
});

test('prefix applies only to the word being spoken, not to earlier words', () => {
  const { matcher, keys } = make([[['песня'], 'Q'], [['лето'], 'W']]);
  assert.deepEqual(keys(matcher.assess('пе лето')), ['W']);
});

test('stability still applies to a prefix match', () => {
  const { matcher, at, keys } = make([[['песня'], 'Q'], [['лето'], 'W']], { wordStabilityMs: 100 });
  at(0); assert.deepEqual(keys(matcher.assess('пе')), []);
  at(60); assert.deepEqual(keys(matcher.assess('пе')), []);
  at(110); assert.deepEqual(keys(matcher.assess('пе')), ['Q']);
});

test('config: checkbox on by default, off keeps whole words, the setting belongs to the whole app', () => {
  assert.equal(DEFAULTS.prefixMatch, true);
  const base = { ...DEFAULTS, mappings: DEFAULTS.mappings };
  assert.equal(validateConfig(base).prefixMatch, true);
  assert.equal(validateConfig({ ...base, prefixMatch: false }).prefixMatch, false);
  const { prefixMatch, ...legacy } = base;
  assert.equal(validateConfig(legacy).prefixMatch, true, 'old settings files get the default');
  const store = validateStore({ ...base, prefixMatch: false });
  assert.equal(store.prefixMatch, false);
  const on = createMatcher(validateConfig({ ...base, prefixMatch: true, wordStabilityMs: 0 }));
  assert.deepEqual(on.assess('пер').actions.map(action => action.key), ['Q']);
  assert.deepEqual(createMatcher(validateConfig({ ...base, wordStabilityMs: 0 })).assess('пе').actions, [], 'fewer than 3 letters never fires');
  const off = createMatcher(validateConfig({ ...base, prefixMatch: false, wordStabilityMs: 0 }));
  assert.deepEqual(off.assess('пер').actions, []);
  assert.deepEqual(off.assess('первый').actions.map(action => action.key), ['Q']);
});
