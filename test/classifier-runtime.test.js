'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { take, background, WORDS, createRandom, RATE } = require('./helpers/synth-voice');
const dsp = require('../src/classifier/dsp');
const { trainClassifier } = require('../src/classifier/train');
const { createArbiter, signature } = require('../src/classifier/arbiter');
const { DEFAULTS, validateConfig, expandMappings } = require('../src/core');
const { validateStore } = require('../src/profiles');

test('signature: variants of one command are the same press, different keys or hold are not', () => {
  const tap = { key: 'Q', modifiers: [], actionType: 'tap' };
  assert.equal(signature(tap), signature({ key: 'Q', actionType: 'tap' }));
  assert.notEqual(signature(tap), signature({ key: 'Q', modifiers: [], actionType: 'hold' }));
  assert.notEqual(signature(tap), signature({ key: 'W', actionType: 'tap' }));
  assert.notEqual(signature(tap), signature({ key: 'Q', modifiers: ['CTRL'], actionType: 'tap' }));
});

test('arbiter: the first source presses, the other is cancelled; repeats and timing', () => {
  let time = 0; const arbiter = createArbiter({ windowMs: 900, now: () => time });
  assert.equal(arbiter.claim('classifier', 'Q'), true, 'first fire goes through');
  time = 300; assert.equal(arbiter.claim('text', 'Q'), false, 'the text recognition finds the same command later: no second press');
  assert.equal(arbiter.pending(), 0);
  time = 400; assert.equal(arbiter.claim('text', 'W'), true, 'text first this time');
  time = 700; assert.equal(arbiter.claim('classifier', 'W'), false);
  time = 1000; assert.equal(arbiter.claim('classifier', 'E'), true); assert.equal(arbiter.claim('classifier', 'E'), true, 'the same word said twice is two presses');
  time = 1100; assert.equal(arbiter.claim('text', 'E'), false); assert.equal(arbiter.claim('text', 'E'), false); assert.equal(arbiter.claim('text', 'E'), true, 'a third text fire has no partner');
  time = 5000; assert.equal(arbiter.claim('classifier', 'R'), true); time = 6500; assert.equal(arbiter.claim('text', 'R'), true, 'too late to be the same word');
  arbiter.claim('classifier', 'T'); arbiter.reset(); assert.equal(arbiter.claim('text', 'T'), true);
});

test('config: the classifier is on by default, belongs to the whole app and not to a profile', () => {
  assert.equal(DEFAULTS.classifierEnabled, true);
  const base = { ...DEFAULTS, mappings: DEFAULTS.mappings };
  const { classifierEnabled, ...legacy } = base;
  assert.equal(validateConfig(legacy).classifierEnabled, true, 'settings files from before the option get it on');
  assert.equal(validateConfig({ ...base, classifierEnabled: false }).classifierEnabled, false, 'a switched-off option stays off');
  assert.equal(validateConfig({ ...base, classifierEnabled: true }).classifierEnabled, true);
  const store = validateStore({ ...base, classifierEnabled: true });
  assert.equal(store.classifierEnabled, true); assert.deepEqual(Object.keys(store.profiles[0].settings), ['mappings', 'neuralWords']);
});

test('classifier words map to commands through the same normalisation as the text recogniser', () => {
  const entries = expandMappings([{ id: 'a', phrases: ['Тяж', 'хэви', 'тяжёлый'], language: 'ru', key: 'Q', actionType: 'hold' }, { id: 'b', phrase: 'четвёртый', language: 'ru', key: 'R' }], 'ru');
  const map = new Map(entries.filter(([key]) => key && !key.includes(' ')));
  assert.equal(map.get('тяж').key, 'Q'); assert.equal(map.get('хэви').actionType, 'hold'); assert.equal(map.get('тяжелый').key, 'Q');
  assert.equal(map.get('четвертый').key, 'R', 'the classifier file name has е for ё, as the matcher key');
});

const random = createRandom(77), clips = [];
for (const name of Object.keys(WORDS)) for (let i = 0; i < 24; i++) { const samples = take(name, random), span = dsp.segmentWord(samples); clips.push({ word: name, samples, start: span.start, end: span.end }); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-worker-')), modelFile = path.join(dir, 'model.json');
test('worker: loads the model, answers ready, fires for a spoken word, ignores other epochs and silence, resets on stop', { timeout: 120000 }, async () => {
  const json = trainClassifier({ clips, background: [background(80, random)], options: { epochs: 7, windowsPerEpoch: 9000, augmentClips: 4, augmentBackground: 2 } });
  fs.writeFileSync(modelFile, JSON.stringify(json));
  const worker = new Worker(path.join(__dirname, '..', 'src', 'classifier', 'classifier-worker.js'), { workerData: { modelFile } }), fires = [], errors = [];
  let ready; const readyPromise = new Promise(resolve => { ready = resolve; });
  worker.on('message', message => { if (message.type === 'ready') ready(message); else if (message.type === 'fire') fires.push(message); else if (message.type === 'error') errors.push(message.message); });
  try {
    const info = await readyPromise;
    assert.deepEqual(info.words, Object.keys(WORDS).sort());
    const speak = (name, epoch) => { const at48 = dsp.resample(take(name, createRandom(5)), RATE, 48000); for (let at = 0; at < at48.length; at += 480) worker.postMessage({ type: 'audio', epoch, samples: at48.slice(at, at + 480), sampleRate: 48000 }); };
    speak('alfa', 1); await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fires.length, 0, 'nothing before the epoch has started');
    worker.postMessage({ type: 'start', epoch: 1 }); speak('alfa', 2); await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fires.length, 0, 'audio of another epoch is dropped');
    speak('bravo', 1); await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(fires.length, 1); assert.equal(fires[0].word, 'bravo'); assert.equal(fires[0].epoch, 1); assert.ok(fires[0].probability >= 0.5 && fires[0].processMs >= 0);
    worker.postMessage({ type: 'stop' }); speak('charlie', 1); await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fires.length, 1, 'stopped workers stay quiet');
    assert.deepEqual(errors, []);
  } finally { await worker.terminate(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('worker: a missing or broken model is reported, not thrown', async () => {
  const worker = new Worker(path.join(__dirname, '..', 'src', 'classifier', 'classifier-worker.js'), { workerData: { modelFile: path.join(os.tmpdir(), 'nope-model.json') } });
  const message = await new Promise(resolve => worker.once('message', resolve));
  assert.equal(message.type, 'error'); await worker.terminate();
});
