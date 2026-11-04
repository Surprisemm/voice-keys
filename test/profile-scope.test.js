'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS } = require('../src/core');
const { validateStore, changeProfile, exportProfiles, importProfiles } = require('../src/profiles');

const global = { language: 'ru', modelId: 'gigaam', commandMode: 'words', wordStabilityMs: 0, prefixMatch: false, speechEndMs: 400, confidenceThreshold: 0.95, listenMode: 'always', holdKey: 'F9' };
const ru = (phrase, key) => ({ phrase, key, language: 'ru' });

test('a profile holds commands only', () => {
  const store = validateStore({ ...DEFAULTS, ...global });
  assert.deepEqual(Object.keys(store.profiles[0].settings), ['mappings', 'neuralWords']);
  assert.deepEqual(Object.keys(exportProfiles(store, 'all').profiles[0].settings), ['mappings', 'neuralWords']);
});

test('switching profiles changes the commands and nothing else', () => {
  let store = validateStore({ ...DEFAULTS, ...global, queueGapMs: 120, mappings: [ru('удар', 'Q')] });
  const first = store.activeProfileId;
  store = changeProfile(store, { operation: 'create', name: 'Дота' });
  store = validateStore({ ...store, mappings: [ru('ульт', 'R')] });
  store = changeProfile(store, { operation: 'switch', id: first });
  assert.deepEqual(store.mappings.map(item => item.key), ['Q']);
  for (const [name, value] of Object.entries({ ...global, queueGapMs: 120 })) assert.deepEqual(store[name], value, name);
  store = changeProfile(store, { operation: 'switch', id: store.profiles.find(item => item.name === 'Дота').id });
  assert.deepEqual(store.mappings.map(item => item.key), ['R']);
  for (const [name, value] of Object.entries({ ...global, queueGapMs: 120 })) assert.deepEqual(store[name], value, name);
});

test('settings saved while one profile is active apply to every profile', () => {
  let store = validateStore({ ...DEFAULTS, ...global, mappings: [ru('удар', 'Q')] });
  const first = store.activeProfileId;
  store = changeProfile(store, { operation: 'create', name: 'Другой', copy: true });
  store = validateStore({ ...store, modelId: 'vosk', prefixMatch: true });
  store = changeProfile(store, { operation: 'switch', id: first });
  assert.equal(store.modelId, 'vosk'); assert.equal(store.prefixMatch, true);
});

test('old files with per-profile settings load: app settings come from the active profile, other profiles keep commands only', () => {
  const old = validateStore({ ...DEFAULTS, ...global, mappings: [ru('удар', 'Q')] });
  old.profiles.push({ id: 'old-dota', name: 'Дота', settings: { language: 'ru', modelId: 'vosk', commandMode: 'phrase', wordStabilityMs: 300, prefixMatch: true, mappings: [ru('ульт', 'R')] } });
  const store = validateStore(old);
  assert.equal(store.modelId, 'gigaam'); assert.equal(store.commandMode, 'words');
  const dota = store.profiles.find(item => item.id === 'old-dota');
  assert.deepEqual(Object.keys(dota.settings), ['mappings', 'neuralWords']);
  assert.equal(dota.settings.mappings[0].key, 'R');
  const switched = changeProfile(store, { operation: 'switch', id: 'old-dota' });
  assert.equal(switched.modelId, 'gigaam'); assert.equal(switched.wordStabilityMs, 0); assert.equal(switched.prefixMatch, false);
});

test('a profile without commands in the current language can still be selected', () => {
  let store = validateStore({ ...DEFAULTS, ...global, mappings: [ru('удар', 'Q')] });
  const first = store.activeProfileId;
  store = changeProfile(store, { operation: 'create', name: 'English' });
  store = validateStore({ ...store, language: 'en', modelId: 'vosk', mappings: [{ phrase: 'echo', key: 'E', language: 'en' }] });
  store = changeProfile(store, { operation: 'switch', id: first });
  assert.equal(store.language, 'en');
  assert.equal(store.mappings[0].language, 'ru', 'the switch is not blocked, the user can change the language');
});

test('imported profile files take only the commands', () => {
  const store = validateStore({ ...DEFAULTS, ...global, mappings: [ru('удар', 'Q')] });
  const file = { format: 'voice-keys-profiles', version: 1, profiles: [{ name: 'Из файла', settings: { language: 'en', modelId: 'vosk', wordStabilityMs: 500, mappings: [ru('блок', 'F')] } }] };
  const { store: next } = importProfiles(store, file);
  assert.equal(next.modelId, 'gigaam'); assert.equal(next.language, 'ru'); assert.equal(next.wordStabilityMs, 0);
  assert.deepEqual(Object.keys(next.profiles.find(item => item.name === 'Из файла').settings), ['mappings', 'neuralWords']);
});
