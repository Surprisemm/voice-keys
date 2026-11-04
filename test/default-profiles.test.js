'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WordCommandMatcher } = require('../src/core');
const { defaultStore, validateStore, changeProfile, changeProfileWords, exportProfiles, importProfiles, GENERAL_ID } = require('../src/profiles');

const named = (store, name) => store.profiles.find(item => item.name === name);

test('a fresh install has one profile, the general one, with the commands of Deadlock', () => {
  const store = defaultStore();
  assert.deepEqual(store.profiles.map(item => item.name), ['Общий']);
  assert.equal(store.activeProfileId, GENERAL_ID);
  const mappings = store.profiles[0].settings.mappings;
  const heavy = mappings.find(item => item.phrases.includes('хэви')), hit = mappings.find(item => item.phrases.includes('удар')), block = mappings.find(item => item.phrases.includes('блок'));
  assert.deepEqual([heavy.key, heavy.actionType, heavy.durationMs], ['Q', 'hold', 1000]);
  assert.deepEqual([hit.key, hit.actionType], ['Q', 'tap']); assert.deepEqual([block.key, block.actionType], ['F', 'tap']);
  const matcher = new WordCommandMatcher(mappings, 'ru', { wordStabilityMs: 0 });
  assert.deepEqual(matcher.assess('первый второй третий четвертый', true).actions.map(action => action.key), ['1', '2', '3', '4']);
  assert.doesNotThrow(() => validateStore(store));
});
test('the general profile cannot be deleted or renamed, and a store always has it', () => {
  const store = defaultStore();
  assert.throws(() => changeProfile(store, { operation: 'delete', id: GENERAL_ID }), /Общий профиль удалить нельзя/);
  assert.throws(() => changeProfile(store, { operation: 'rename', id: GENERAL_ID, name: 'Мой' }), /переименовать нельзя/);
  const renamed = validateStore({ ...store, profiles: [{ ...store.profiles[0], name: 'Что-то другое' }] });
  assert.equal(renamed.profiles[0].name, 'Общий', 'the name is kept');
  const without = validateStore({ ...store, profiles: [{ id: 'other', name: 'Dota', settings: { mappings: [] } }], activeProfileId: 'other' });
  assert.deepEqual(without.profiles.map(item => item.id), [GENERAL_ID, 'other']);
  assert.throws(() => changeProfile(store, { operation: 'create', name: 'общий' }), /уникальны/);
});
test('a profile can be added, duplicated with its commands and words, and deleted', () => {
  let store = changeProfile(defaultStore(), { operation: 'create', name: 'Dota' });
  const dota = named(store, 'Dota'); assert.equal(store.activeProfileId, dota.id); assert.deepEqual(dota.settings.mappings, []);
  store = changeProfileWords(store, { profileId: dota.id, operation: 'add', word: 'Первый' });
  store = changeProfileWords(store, { profileId: dota.id, operation: 'add', word: 'ульт' });
  assert.deepEqual(named(store, 'Dota').settings.neuralWords, ['первый', 'ульт']);
  store = changeProfile(store, { operation: 'duplicate', id: dota.id, name: 'Dota (копия)' });
  const copy = named(store, 'Dota (копия)'); assert.deepEqual(copy.settings.neuralWords, ['первый', 'ульт']); assert.equal(store.activeProfileId, copy.id);
  store = changeProfile(store, { operation: 'delete', id: copy.id });
  assert.deepEqual(store.profiles.map(item => item.name), ['Общий', 'Dota']); assert.equal(store.activeProfileId, GENERAL_ID);
});
test('words of a profile: the active one lives in the top-level fields, a removed word leaves the commands too, wrong input is refused', () => {
  let store = changeProfile(defaultStore(), { operation: 'create', name: 'Dota' }); const id = named(store, 'Dota').id;
  store = validateStore({ ...store, mappings: [{ id: 'm', phrases: ['первый'], trainedWords: ['первый'], key: 'Q', language: 'ru' }] });
  assert.deepEqual(store.neuralWords, ['первый'], 'a word used by a command is a word of the profile');
  store = changeProfileWords(store, { profileId: id, operation: 'remove', word: 'первый' });
  assert.deepEqual(store.neuralWords, []); assert.deepEqual(store.mappings[0].trainedWords, []); assert.deepEqual(named(store, 'Dota').settings.mappings[0].trainedWords, []);
  assert.throws(() => changeProfileWords(store, { profileId: id, operation: 'add', word: '???' }), /одно слово/);
  assert.throws(() => changeProfileWords(store, { profileId: 'nope', operation: 'add', word: 'а' }), /не найден/);
  const other = changeProfileWords(changeProfile(store, { operation: 'switch', id: GENERAL_ID }), { profileId: id, operation: 'add', word: 'ульт' });
  assert.deepEqual(named(other, 'Dota').settings.neuralWords, ['ульт'], 'a profile that is not active');
});
test('exported profiles keep their words', () => {
  let store = changeProfile(defaultStore(), { operation: 'create', name: 'Dota' }); store = changeProfileWords(store, { profileId: named(store, 'Dota').id, operation: 'add', word: 'ульт' });
  const file = exportProfiles(store, 'all'), imported = importProfiles(defaultStore(), file);
  assert.deepEqual(named(imported.store, 'Dota').settings.neuralWords, ['ульт']);
});
