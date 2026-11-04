'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, normalize, validateConfig, CommandMatcher } = require('../src/core');
const settings = () => structuredClone(DEFAULTS);
const words = (text, confidence = 0.99, offset = 0) => text.split(' ').map((word, index) => ({ word, conf: confidence, start: offset + index * 0.3, end: offset + index * 0.3 + 0.25 }));
test('normalization equates е/ё while stored phrases preserve ё', () => {
  assert.equal(normalize('  ЧЕТВЁРТЫЙ! '), 'четвертый');
  assert.equal(validateConfig(settings()).mappings[3].phrase, 'четвёртый');
});
test('legacy settings get confidence and microphone defaults without losing mappings', () => {
  const config = settings(); delete config.confidenceThreshold; delete config.microphoneLabel;
  config.mappings[3].phrase = 'четвертый';
  const valid = validateConfig(config);
  assert.equal(valid.confidenceThreshold, 0.85); assert.equal(valid.microphoneLabel, '');
  assert.equal(valid.mappings[3].phrase, 'четвертый');
});
test('macros, chords and listener conflicts are rejected', () => {
  for (const key of ['Q,W,E', 'CTRL+Q', ['Q', 'W'], 'WIN', 'F25', 'F9']) { const config = settings(); config.listenMode = 'hold'; config.mappings[0].key = key; assert.throws(() => validateConfig(config)); }
});
test('duplicates are rejected across е and ё spellings', () => {
  const config = settings(); config.mappings.push({ phrase: 'ЧЕТВЕРТЫЙ', key: 'T', language: 'ru' });
  assert.throws(() => validateConfig(config), /повторяется/);
});
test('active language needs commands and mixed scripts are rejected', () => {
  const config = settings(); config.mappings = config.mappings.filter(mapping => mapping.language === 'en'); assert.throws(() => validateConfig(config), /хотя бы одну/);
  const mixed = settings(); mixed.mappings[0].phrase = 'первый q'; assert.throws(() => validateConfig(mixed), /выбранного языка/);
});
test('only exact whole final utterances match, never substrings or sequences', () => {
  const matcher = new CommandMatcher(DEFAULTS.mappings, 'ru');
  for (const phrase of ['первый второй', 'не нажимай первый', 'это первый тест', 'queue']) assert.equal(matcher.accept(phrase, true, words(phrase)), null);
  assert.equal(matcher.accept('первый', true, words('первый')).key, 'Q');
});
test('regression from user logs: withdrawn partials never trigger', () => {
  const matcher = new CommandMatcher(DEFAULTS.mappings, 'ru');
  for (let repeat = 0; repeat < 50; repeat++) assert.equal(matcher.accept('третий', false), null);
  assert.equal(matcher.accept('', true), null);
  assert.equal(matcher.accept('первый', false), null);
  assert.equal(matcher.accept('первый день отпуска', true, words('первый день отпуска')), null);
});
test('четвёртый from the unrestricted recognizer matches legacy четвертый → R', () => {
  const mappings = structuredClone(DEFAULTS.mappings); mappings[3].phrase = 'четвертый';
  const matcher = new CommandMatcher(mappings, 'ru');
  assert.equal(matcher.accept('четвёртый', true, words('четвёртый')).key, 'R');
});
test('low-confidence final words are rejected with an explicit reason', () => {
  const matcher = new CommandMatcher(DEFAULTS.mappings, 'ru');
  assert.equal(matcher.assess('первый', true, words('первый', 0.7)).reason, 'confidence_too_low');
  assert.equal(matcher.accept('первый', true, words('первый', 0.9)).key, 'Q');
});
test('a weak word is rejected even when the average is high', () => {
  const matcher = new CommandMatcher([{ phrase: 'один два три четыре', language: 'ru', key: 'Q' }], 'ru');
  const details = words('один два три четыре'); details[2].conf = 0.6;
  assert.equal(matcher.assess('один два три четыре', true, details).reason, 'confidence_too_low');
});
test('missing, mismatched and malformed word scores cannot generate input', () => {
  const matcher = new CommandMatcher(DEFAULTS.mappings, 'ru');
  for (const details of [[], null, words('второй'), [{ word: 'первый', conf: NaN, start: 0, end: 1 }], [{ word: 'первый', conf: 1.2, start: 0, end: 1 }], [{ word: 'первый', conf: 1, start: 1, end: 0 }]]) {
    assert.equal(matcher.assess('первый', true, details).reason, 'word_details_missing');
  }
});
test('unknown speech marker is rejected instead of being stripped into a command', () => {
  const matcher = new CommandMatcher(DEFAULTS.mappings, 'ru');
  assert.equal(matcher.assess('[unk] первый', true, words('первый')).reason, 'unknown_speech');
});
test('duplicate finals are ignored while a newly spoken command can repeat', () => {
  const matcher = new CommandMatcher(DEFAULTS.mappings, 'ru');
  assert.equal(matcher.accept('первый', true, words('первый')).key, 'Q');
  assert.equal(matcher.assess('первый', true, words('первый')).reason, 'duplicate_result');
  assert.equal(matcher.accept('первый', true, words('первый', 0.99, 3)).key, 'Q');
  matcher.reset(); assert.equal(matcher.accept('первый', true, words('первый')).key, 'Q');
});
test('longer configured phrases do not fire shorter prefixes', () => {
  const matcher = new CommandMatcher([{ phrase: 'огонь', key: 'Q', language: 'ru' }, { phrase: 'огонь небес', key: 'W', language: 'ru' }], 'ru');
  assert.equal(matcher.accept('огонь', false), null); assert.equal(matcher.accept('огонь небес', true, words('огонь небес')).key, 'W');
});
test('strict threshold rejects borderline commands accepted in normal mode', () => {
  const normal = new CommandMatcher(DEFAULTS.mappings, 'ru');
  const strict = new CommandMatcher(DEFAULTS.mappings, 'ru', { confidenceThreshold: 0.95 });
  assert.equal(normal.accept('первый', true, words('первый', 0.9)).key, 'Q');
  assert.equal(strict.accept('первый', true, words('первый', 0.9)), null);
});
test('English uses its own mappings', () => {
  const matcher = new CommandMatcher(DEFAULTS.mappings, 'en');
  assert.equal(matcher.accept('double you', true, words('double you')).key, 'W');
  assert.equal(matcher.accept('первый', true, words('первый')), null);
});
test('English letter spellings preserve existing queue, double you and are commands', () => {
  const legacy = structuredClone(DEFAULTS.mappings); legacy.find(mapping => mapping.id === 'en-r').phrase = 'are';
  const matcher = new CommandMatcher(legacy, 'en');
  assert.equal(matcher.accept('q', true, words('q')).key, 'Q');
  assert.equal(matcher.accept('w', true, words('w')).key, 'W');
  assert.equal(matcher.accept('r', true, words('r')).key, 'R');
  assert.equal(matcher.accept('we are ready', true, words('we are ready')), null);
});
test('identical spoken English letter names cannot be assigned conflicting keys', () => {
  const config = settings(); config.mappings.push({ phrase: 'q', key: 'T', language: 'en' });
  assert.throws(() => validateConfig(config), /повторяется/);
});
test('the ordinary English word he never becomes the E command', () => {
  const legacy = structuredClone(DEFAULTS.mappings); legacy.find(mapping => mapping.id === 'en-e').phrase = 'e';
  const matcher = new CommandMatcher(legacy, 'en');
  assert.equal(matcher.accept('he', true, words('he')), null);
  assert.equal(matcher.accept('e', true, words('e')).key, 'E');
});
