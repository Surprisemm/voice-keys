'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { take, createRandom, RATE } = require('./helpers/synth-voice');
const { resample } = require('../src/classifier/dsp');
const { createClassifierStore } = require('../src/classifier/store');
const { loadDataset } = require('../src/classifier/train');
const { profileWords, trainingPlan, chooseModel, scopeOf } = require('../src/classifier/scopes');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vk-scope-'));
const at48 = samples => resample(samples, RATE, 48000);
const profile = (id, words) => ({ id, name: id, settings: { mappings: [], neuralWords: words } });
const fakeModel = word => ({ format: 'voice-keys-classifier', version: 2, arch: 'gru', words: [word], threshold: 0.9, report: { rows: [] } });

test('the general profile knows the whole library, another profile only its own words', () => {
  assert.deepEqual(profileWords({ id: 'profile-default', settings: { neuralWords: ['x'] } }, ['б', 'а']), ['а', 'б']);
  assert.deepEqual(profileWords(profile('dota', ['первый', 'ульт']), ['а']), ['первый', 'ульт']);
  assert.deepEqual(profileWords({ id: 'dota' }, []), []);
  assert.equal(scopeOf('profile-default'), 'shared'); assert.equal(scopeOf('dota'), 'dota');
});
test('the plan of a profile: its words with enough recordings, the warning for weak and missing ones, the general plan takes the library', () => {
  const profiles = [{ id: 'profile-default', name: 'Общий', settings: { neuralWords: [] } }, profile('deadlock', ['первый', 'удар', 'блок', 'атака']), profile('dota', ['первый', 'ульт']), profile('empty', [])];
  const counts = { первый: 30, удар: 3, хэви: 30, ульт: 12, блок: 20 };
  const deadlock = trainingPlan('deadlock', counts, profiles);
  assert.deepEqual(deadlock.words, ['первый', 'блок']); assert.deepEqual(deadlock.weak, ['блок']); assert.deepEqual(deadlock.fewTakes, ['удар']); assert.deepEqual(deadlock.notRecorded, ['атака']);
  assert.equal(deadlock.ok, true); assert.equal(deadlock.scope, 'deadlock');
  assert.deepEqual(trainingPlan('dota', counts, profiles).words, ['первый', 'ульт']);
  const general = trainingPlan('profile-default', counts, profiles);
  assert.deepEqual(general.words, ['блок', 'первый', 'ульт', 'хэви']); assert.equal(general.scope, 'shared');
  assert.match(trainingPlan('empty', counts, profiles).error, /нет слов/);
  assert.match(trainingPlan('dota', { первый: 2 }, profiles).error, /Ни у одного/);
  assert.equal(trainingPlan('nope', counts, profiles).ok, false);
});
test('a profile uses its own network, otherwise the shared one; the general profile only the shared one', () => {
  assert.equal(chooseModel('dota', { dota: {}, shared: {} }), 'dota');
  assert.equal(chooseModel('dota', { shared: {} }), 'shared');
  assert.equal(chooseModel('dota', { deadlock: {} }), null);
  assert.equal(chooseModel('profile-default', { 'profile-default': {}, shared: {} }), 'shared');
  assert.equal(chooseModel('dota', {}), null);
});
test('the store keeps a network per profile and a shared one; the old single model becomes the shared network', () => {
  const dir = temp();
  try {
    fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(fakeModel('старое')));
    const store = createClassifierStore(dir);
    assert.equal(fs.existsSync(path.join(dir, 'model.json')), false);
    assert.deepEqual(store.status().models.shared.words, ['старое']); assert.deepEqual(store.status().model.words, ['старое']);
    store.saveModel(fakeModel('первый'), 'profile-dota');
    assert.deepEqual(Object.keys(store.status().models).sort(), ['profile-dota', 'shared']);
    assert.deepEqual(store.modelInfo('profile-dota').words, ['первый']);
    store.removeModel('profile-dota');
    assert.deepEqual(Object.keys(store.status().models), ['shared']);
    assert.throws(() => store.modelPath('../evil'), /Некорректное/);
    store.removeAll(); assert.deepEqual(store.status().models, {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('a network can be trained on a part of the library', () => {
  const dir = temp(), store = createClassifierStore(dir), random = createRandom(7);
  try {
    for (const word of ['альфа', 'браво', 'чарли']) for (let i = 0; i < 2; i++) assert.equal(store.addTake(word, at48(take(word === 'альфа' ? 'alfa' : word === 'браво' ? 'bravo' : 'charlie', random)), 48000).ok, true);
    assert.deepEqual([...new Set(loadDataset(dir).clips.map(clip => clip.word))].sort(), ['альфа', 'браво', 'чарли']);
    assert.deepEqual([...new Set(loadDataset(dir, ['браво']).clips.map(clip => clip.word))], ['браво']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
