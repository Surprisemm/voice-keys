'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WordCommandMatcher, validateConfig, DEFAULTS } = require('../src/core');

// one command with two spellings, plus another command
const mappings = validateConfig({ ...DEFAULTS, mappings: [
  { id: 'heavy', phrases: ['тяж', 'тяш'], key: 'Q', language: 'ru', actionType: 'hold', durationMs: 1000 },
  { id: 'one', phrases: ['первый'], key: '1', language: 'ru' }
] }).mappings;
const matcher = () => new WordCommandMatcher(mappings, 'ru', { wordStabilityMs: 0 });
const keys = result => result.actions.map(action => action.key);

test('a word rewritten by the model into another spelling of the same command is pressed once', () => {
  const m = matcher();
  assert.deepEqual(keys(m.assess('тяж')), ['Q']);
  assert.deepEqual(keys(m.assess('тяш')), [], 'the rewrite is the same word');
  assert.deepEqual(keys(m.assess('тяж')), []);
  assert.deepEqual(keys(m.assess('тяш', true)), []);
});
test('the same command said twice is pressed twice, in one spelling or in two', () => {
  const same = matcher(); assert.deepEqual(keys(same.assess('тяж')), ['Q']); assert.deepEqual(keys(same.assess('тяж тяж')), ['Q']);
  const two = matcher(); assert.deepEqual(keys(two.assess('тяж тяш', true)), ['Q', 'Q']);
});
test('different commands keep their own count', () => {
  const m = matcher();
  assert.deepEqual(keys(m.assess('первый тяж')), ['1', 'Q']);
  assert.deepEqual(keys(m.assess('первый тяш')), []);
  assert.deepEqual(keys(m.assess('первый тяш первый', true)), ['1']);
});
