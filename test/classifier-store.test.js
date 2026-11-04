'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { take, background, WORDS, createRandom, RATE } = require('./helpers/synth-voice');
const { resample, readWav } = require('../src/classifier/dsp');
const { createClassifierStore, cleanWord } = require('../src/classifier/store');
const { startTraining } = require('../src/classifier/trainer');
const { loadModel } = require('../src/classifier/detector');
const mlSetup = require('../src/ml-setup');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vk-cls-'));
const at48 = samples => resample(samples, RATE, 48000);

test('words are lower-case single tokens', () => {
  assert.equal(cleanWord('  Удар! '), 'удар'); assert.equal(cleanWord('Четвёртый'), 'четвертый'); assert.equal(cleanWord('a b'), 'ab'); assert.equal(cleanWord('???'), '');
});

test('store: a good take is kept with context, counted and listed; bad takes are refused with a reason', () => {
  const dir = temp(), store = createClassifierStore(dir), random = createRandom(2);
  try {
    const good = store.addTake('Удар', at48(take('alfa', random)), 48000);
    assert.equal(good.ok, true); assert.equal(good.count, 1); assert.ok(good.durationMs > 200 && good.durationMs < 900, `${good.durationMs}`);
    const file = path.join(dir, 'words', 'удар', fs.readdirSync(path.join(dir, 'words', 'удар'))[0]), saved = readWav(fs.readFileSync(file));
    assert.equal(saved.rate, 48000); assert.ok(saved.samples.length / 48000 > good.durationMs / 1000 + 0.5, 'silence around the word is kept');
    assert.equal(store.status().words['удар'], 1);

    assert.match(store.addTake('удар', new Float32Array(48000 * 2).map(() => (random.uniform() - 0.5) * 0.002), 48000).reason, /Речь не слышна/);
    assert.match(store.addTake('удар', new Float32Array(100), 48000).reason, /пуста/);
    const quiet = at48(take('alfa', random)).map(v => v * 0.05); assert.match(store.addTake('удар', quiet, 48000).reason, /тихо|не слышна/);
    const loud = at48(take('alfa', random)).map(v => Math.max(-1, Math.min(1, v * 40))); assert.match(store.addTake('удар', loud, 48000).reason, /перегружен/);
    const long = new Float32Array(48000 * 3); long.set(at48(take('alfa', random)).subarray(0, 48000)); long.set(at48(take('bravo', random)).subarray(0, 48000), 48000 + 4000); long.set(at48(take('charlie', random)).subarray(0, 48000), 48000 * 2);
    assert.match(store.addTake('удар', long, 48000).reason, /долго|коротк|не слышна/);
    assert.equal(store.status().words['удар'], 1, 'refused takes are not stored');
    assert.throws(() => store.addTake('???', at48(take('alfa', random)), 48000), /слово/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('store: background, removal of the last take, a word, the background, everything', () => {
  const dir = temp(), store = createClassifierStore(dir), random = createRandom(4);
  try {
    assert.equal(store.addBackground(new Float32Array(48000), 48000).ok, false);
    assert.equal(store.addBackground(at48(background(5, random)), 48000).ok, true);
    assert.equal(store.status().backgroundSeconds, 5);
    store.addTake('первый', at48(take('alfa', random)), 48000); store.addTake('первый', at48(take('alfa', random)), 48000); store.addTake('второй', at48(take('bravo', random)), 48000);
    assert.deepEqual(store.status().words, { первый: 2, второй: 1 });
    store.removeLastTake('первый'); assert.equal(store.status().words['первый'], 1);
    store.removeLastTake('первый'); assert.equal(store.status().words['первый'], undefined, 'an empty word disappears');
    store.removeWord('второй'); assert.deepEqual(store.status().words, {});
    store.removeBackground(); assert.equal(store.status().backgroundSeconds, 0);
    store.saveModel({ format: 'voice-keys-classifier', version: 2, arch: 'gru', words: ['a'], threshold: 0.9, report: { rows: [{ threshold: 0.9, detected: 1, backgroundFalse: 0, latencyMedianMs: 100 }] } });
    assert.equal(store.status().model.threshold, 0.9); assert.equal(store.status().model.row.detected, 1);
    store.removeAll(); assert.equal(store.status().model, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fillStore(store, takes) {
  const random = createRandom(31);
  for (const name of Object.keys(WORDS)) for (let i = 0; i < takes; i++) assert.equal(store.addTake(name, at48(take(name, random)), 48000).ok, true);
  assert.equal(store.addBackground(at48(background(40, random)), 48000).ok, true);
}

test('training from the store with the built-in trainer produces a loadable model', { timeout: 180000 }, async () => {
  const dir = temp(), store = createClassifierStore(dir);
  try {
    fillStore(store, 12);
    const progress = [], job = startTraining({ dataDir: store.dir, modelFile: store.modelFile, mlDir: path.join(dir, 'no-ml'), scriptsDir: path.join(__dirname, '..', 'tools', 'ml'), epochs: 4, onProgress: p => progress.push(p.type) });
    assert.equal(job.engine, 'js');
    const result = await job.promise;
    assert.equal(result.engine, 'js'); assert.ok(progress.includes('progress'));
    const model = loadModel(JSON.parse(fs.readFileSync(store.modelFile, 'utf8')));
    assert.deepEqual(model.words, Object.keys(WORDS).sort());
    assert.equal(fs.existsSync(`${store.modelFile}.training`), false, 'the temporary file is gone');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('training can be cancelled and leaves no half-written model', { timeout: 120000 }, async () => {
  const dir = temp(), store = createClassifierStore(dir);
  try {
    fillStore(store, 10);
    const job = startTraining({ dataDir: store.dir, modelFile: store.modelFile, mlDir: path.join(dir, 'no-ml'), scriptsDir: dir, epochs: 30 });
    setTimeout(() => job.cancel(), 1500);
    await assert.rejects(job.promise, /отменено/);
    assert.equal(fs.existsSync(store.modelFile), false); assert.equal(fs.existsSync(`${store.modelFile}.training`), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const python = mlSetup.venvPython(path.join(__dirname, '..', 'data', 'ml'));
test('training from the store with PyTorch (a few steps) produces a GRU model the app can load', { timeout: 240000, skip: !fs.existsSync(python) && 'Python environment not installed (npm run setup-ml)' }, async () => {
  const dir = temp(), store = createClassifierStore(dir);
  try {
    fillStore(store, 10);
    const lines = [], job = startTraining({ dataDir: store.dir, modelFile: store.modelFile, mlDir: path.join(__dirname, '..', 'data', 'ml'), scriptsDir: path.join(__dirname, '..', 'tools', 'ml'), steps: 60, onProgress: p => lines.push(p.type) });
    assert.equal(job.engine, 'python');
    const result = await job.promise;
    assert.equal(result.engine, 'python'); assert.ok(lines.includes('progress') && lines.includes('done'));
    const model = loadModel(JSON.parse(fs.readFileSync(store.modelFile, 'utf8')));
    assert.equal(model.version, 2); assert.equal(model.arch, 'gru'); assert.deepEqual(model.words, Object.keys(WORDS).sort());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PyTorch trains a network of one profile on a chosen part of the library', { timeout: 240000, skip: !fs.existsSync(python) && 'Python environment not installed (npm run setup-ml)' }, async () => {
  const dir = temp(), store = createClassifierStore(dir);
  try {
    fillStore(store, 10);
    const chosen = Object.keys(WORDS).sort().slice(0, 2), file = store.modelPath('profile-test');
    const job = startTraining({ dataDir: store.dir, modelFile: file, words: chosen, mlDir: path.join(__dirname, '..', 'data', 'ml'), scriptsDir: path.join(__dirname, '..', 'tools', 'ml'), steps: 60 });
    await job.promise;
    assert.deepEqual(loadModel(JSON.parse(fs.readFileSync(file, 'utf8'))).words, chosen);
    assert.deepEqual(Object.keys(store.status().models), ['profile-test']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('python environment plan: uv first, plain Python second, a clear error with neither; CPU index without a NVIDIA card', () => {
  const withUv = mlSetup.plan({ mlDir: 'M', nvidia: true, uv: 'uv', python: null });
  assert.equal(withUv.length, 2); assert.deepEqual(withUv[0].args.slice(0, 3), ['venv', '--python', '3.12']);
  assert.ok(withUv[1].args.includes(mlSetup.INDEX.cuda) && withUv[1].args.includes(`torch==${mlSetup.TORCH_VERSION}`));
  const cpu = mlSetup.plan({ mlDir: 'M', nvidia: false, uv: null, python: 'python.exe' });
  assert.equal(cpu[0].command, 'python.exe'); assert.ok(cpu[1].args.includes(mlSetup.INDEX.cpu));
  assert.throws(() => mlSetup.plan({ mlDir: 'M', nvidia: false, uv: null, python: null }), /Не найден ни uv, ни Python/);
});

test('python environment setup runs every step and checks that PyTorch starts', async () => {
  const dir = temp(), ran = [], lines = [];
  try {
    await assert.rejects(mlSetup.setup({ mlDir: dir, nvidia: false, uv: 'uv', onLine: l => lines.push(l), runCommand: async (command, args) => { ran.push([command, args[0]]); } }), /PyTorch не запускается/);
    assert.deepEqual(ran.map(r => r[1]), ['venv', 'pip']); assert.ok(lines.some(l => l.startsWith('==')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
