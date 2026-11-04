'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, validateConfig, CommandMatcher, WordCommandMatcher, phraseList } = require('../src/core');
const words = (text, confidence = 0.99) => text.split(' ').map((word, index) => ({ word, conf: confidence, start: index * 0.3, end: index * 0.3 + 0.25 }));
const config = mappings => validateConfig({ ...DEFAULTS, mappings });

test('one key accepts several spoken variants written with commas', () => {
  const valid = config([{ phrase: 'ку, кью; ку-ку', key: 'Q', language: 'ru' }]);
  assert.deepEqual(valid.mappings[0].phrases, ['ку', 'кью', 'ку ку']);
  assert.equal(valid.mappings[0].phrase, 'ку');
  const matcher = new CommandMatcher(valid.mappings, 'ru');
  for (const heard of ['ку', 'кью', 'ку ку']) assert.equal(matcher.accept(heard, true, words(heard)).key, 'Q');
});
test('variants can also be given as an array and survive a settings round trip', () => {
  const valid = config([{ phrases: ['один', 'раз'], key: '1', language: 'ru' }]);
  assert.deepEqual(validateConfig({ ...valid }).mappings[0].phrases, ['один', 'раз']);
  assert.deepEqual(phraseList({ phrase: 'а, б' }), ['а', 'б']);
});
test('command one and command two can press the same key', () => {
  const valid = config([{ phrase: 'команда один', key: 'T', language: 'ru' }, { phrase: 'команда два', key: 'T', language: 'ru' }]);
  const matcher = new CommandMatcher(valid.mappings, 'ru');
  assert.equal(matcher.accept('команда один', true, words('команда один')).key, 'T');
  assert.equal(matcher.accept('команда два', true, words('команда два')).key, 'T');
});
test('a variant already used by another key is rejected, a repeat inside one row is merged', () => {
  assert.throws(() => config([{ phrase: 'ку', key: 'Q', language: 'ru' }, { phrase: 'пэ, ку', key: 'W', language: 'ru' }]), /повторяется/);
  assert.deepEqual(config([{ phrase: 'ку, Ку, ку', key: 'Q', language: 'ru' }]).mappings[0].phrases, ['ку']);
});
test('every variant must use the letters of the row language', () => {
  assert.throws(() => config([{ phrase: 'ку, kyu', key: 'Q', language: 'ru' }]), /выбранного языка/);
  assert.throws(() => config([{ phrase: ' , ', key: 'Q', language: 'ru' }]), /нужна фраза/);
  assert.throws(() => config([{ phrases: Array.from({ length: 31 }, (_, i) => `слово${'а'.repeat(i + 1)}`), key: 'Q', language: 'ru' }]), /до 30/);
});
test('English variants: the letter and the heard word both press Q', () => {
  const matcher = new CommandMatcher(config([{ phrase: 'queue, pew', key: 'Q', language: 'en' }, { phrase: 'первый', key: 'R', language: 'ru' }]).mappings, 'en');
  assert.equal(matcher.accept('pew', true, words('pew')).key, 'Q');
  assert.equal(matcher.accept('q', true, words('q')).key, 'Q');
});
test('word mode presses once per spoken variant', () => {
  const valid = config([{ phrase: 'ку, кью', key: 'Q', language: 'ru' }]);
  const matcher = new WordCommandMatcher(valid.mappings, 'ru', { wordStabilityMs: 0 });
  assert.deepEqual(matcher.assess('ку кью ку', true).actions.map(action => [action.key, action.phrase]), [['Q', 'ку'], ['Q', 'кью'], ['Q', 'ку']]);
});
test('learned variants skip the confidence check; typed ones keep it', () => {
  const valid = config([{ phrase: 'ку, пэ', learned: ['пэ'], key: 'Q', language: 'ru' }]);
  assert.deepEqual(valid.mappings[0].learned, ['пэ']);
  const matcher = new CommandMatcher(valid.mappings, 'ru');
  assert.equal(matcher.accept('пэ', true, words('пэ', 0.3)).key, 'Q');
  assert.equal(matcher.assess('ку', true, words('ку', 0.3)).reason, 'confidence_too_low');
  assert.deepEqual(config([{ phrase: 'ку', learned: ['пэ'], key: 'Q', language: 'ru' }]).mappings[0].learned, []);
});
test('old single-phrase settings keep working and gain a phrases list', () => {
  const valid = validateConfig(structuredClone(DEFAULTS));
  assert.deepEqual(valid.mappings[0].phrases, ['первый']);
  assert.deepEqual(valid.mappings[0].learned, []);
});
