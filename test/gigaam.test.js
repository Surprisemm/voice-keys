'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DEFAULTS, validateConfig, createMatcher } = require('../src/core');
const { MODELS, modelFiles, modelFilesReady } = require('../src/models');

test('model file lookup accepts int8 or plain weights and reports missing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-models-'));
  try {
    assert.equal(modelFilesReady(root, 'gigaam'), false);
    const directory = path.join(root, MODELS.gigaam.directory); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'tokens.txt'), 'a'); assert.equal(modelFilesReady(root, 'gigaam'), false);
    fs.writeFileSync(path.join(directory, 'model.int8.onnx'), 'x');
    assert.deepEqual(modelFiles(root, 'gigaam').map(file => path.basename(file)), ['model.int8.onnx', 'tokens.txt']);
    assert.equal(modelFiles(root, 'unknown'), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('GigaAM is a Russian-only model without a confidence check', () => {
  assert.equal(validateConfig({ ...DEFAULTS, modelId: 'gigaam' }).modelId, 'gigaam');
  assert.throws(() => validateConfig({ ...DEFAULTS, modelId: 'gigaam', language: 'en' }), /поддерживают русский/);
  assert.throws(() => validateConfig({ ...DEFAULTS, modelId: 'whisper' }), /Неизвестная модель/);
  const matcher = createMatcher({ ...DEFAULTS, modelId: 'gigaam', commandMode: 'phrase' });
  assert.equal(matcher.assess('первый', true).action.key, 'Q');
});

// Runs the real model on the sample that ships inside the model folder; skipped until the model is downloaded.
const sample = path.join(__dirname, '..', 'models', MODELS.gigaam.directory, 'test_wavs', 'example.wav');
const files = modelFiles(path.join(__dirname, '..', 'models'), 'gigaam');
test('GigaAM worker streams partial text and returns the final text of an utterance', { skip: !files || !fs.existsSync(sample), timeout: 60000 }, async () => {
  const bytes = fs.readFileSync(sample); let pos = 12, rate = 16000, data;
  while (pos + 8 <= bytes.length) { const tag = bytes.toString('ascii', pos, pos + 4), size = bytes.readUInt32LE(pos + 4); if (tag === 'fmt ') rate = bytes.readUInt32LE(pos + 12); if (tag === 'data') data = bytes.subarray(pos + 8, pos + 8 + size); pos += 8 + size + size % 2; }
  const pcm = new Float32Array(data.length / 2); for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(i * 2) / 32768;
  const worker = new Worker(path.join(__dirname, '..', 'src', 'gigaam-worker.js'), { workerData: { model: files[0], tokens: files[1] } });
  const events = [];
  try {
    await new Promise((resolve, reject) => { worker.once('error', reject); worker.on('message', message => { if (message.type === 'ready') resolve(); else if (message.type === 'error') reject(new Error(message.message)); else if (message.type === 'recognition') events.push(message.value); }); });
    worker.postMessage({ type: 'start', epoch: 7 });
    for (let at = 0; at < pcm.length; at += 1024) worker.postMessage({ type: 'audio', epoch: 7, sampleRate: rate, samples: pcm.slice(at, at + 1024) });
    worker.postMessage({ type: 'audio', epoch: 99, sampleRate: rate, samples: new Float32Array(1024) });
    worker.postMessage({ type: 'flush', epoch: 7 });
    await new Promise(resolve => { const timer = setInterval(() => { if (events.some(event => event.type === 'final')) { clearInterval(timer); resolve(); } }, 50); });
    const final = events.find(event => event.type === 'final');
    assert.ok(events.filter(event => event.type === 'partial').length >= 2, 'expected interim results');
    assert.match(final.text, /лукоморья/); assert.deepEqual([final.epoch, final.modelId], [7, 'gigaam']);
  } finally { await worker.terminate(); }
});
