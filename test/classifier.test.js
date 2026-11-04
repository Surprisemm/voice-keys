'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { take, background, WORDS, createRandom, RATE } = require('./helpers/synth-voice');
const dsp = require('../src/classifier/dsp');
const { Mlp, Trainer } = require('../src/classifier/model');
const { loadModel, ClassifierDetector, createFirer } = require('../src/classifier/detector');
const { trainClassifier, labelFrames } = require('../src/classifier/train');

test('wav round trip and mono mixdown', () => {
  const samples = Float32Array.from({ length: 800 }, (_, i) => Math.sin(i / 7) * 0.5);
  const back = dsp.readWav(dsp.writeWav(samples, 16000));
  assert.equal(back.rate, 16000); assert.equal(back.samples.length, 800);
  assert.ok(Math.abs(back.samples[100] - samples[100]) < 1e-3);
  assert.throws(() => dsp.readWav(Buffer.from('not a wav')), /WAV/);
});

test('resampler: right length, right pitch, no seams between chunks of different sizes', () => {
  const from = 44100, n = from * 2, x = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 1000 * i / from));
  const resampler = new dsp.Resampler(from, 16000), parts = []; let at = 0, round = 0;
  while (at < n) { const size = Math.min(n - at, [441, 1023, 127, 2000][round++ % 4]); parts.push(...resampler.push(x.subarray(at, at + size))); at += size; }
  const y = Float32Array.from(parts);
  assert.ok(Math.abs(y.length - 32000) <= 2, `length ${y.length}`);
  let crossings = 0; for (let i = 101; i < y.length; i++) if (y[i - 1] < 0 && y[i] >= 0) crossings++;
  assert.ok(Math.abs(crossings / ((y.length - 100) / 16000) - 1000) < 10);
  let step = 0; for (let i = 200; i < y.length - 1; i++) step = Math.max(step, Math.abs(y[i + 1] - y[i]));
  assert.ok(step < 0.21, `seam: step ${step}`);
});

test('log-mel frames: one frame per 10 ms, louder sound gives higher energy, a tone lights the right band', () => {
  const quiet = new Float32Array(RATE).fill(0), tone = Float32Array.from({ length: RATE }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 1000 * i / RATE));
  const a = dsp.logMel(quiet), b = dsp.logMel(tone);
  assert.equal(a.length, Math.floor((RATE - 400) / 160) + 1);
  assert.ok(b[20][10] > a[20][10] + 5);
  const peak = b[20].indexOf(Math.max(...b[20]));
  assert.ok(peak > 8 && peak < 18, `peak band ${peak}`);
});

test('segmentWord finds the spoken part and refuses silence', () => {
  const random = createRandom(3), samples = take('alfa', random), span = dsp.segmentWord(samples);
  assert.ok(span && span.start > RATE * 0.2 && span.end < samples.length - RATE * 0.2, JSON.stringify(span));
  assert.equal(dsp.segmentWord(new Float32Array(RATE).map(() => random.normal() * 0.001)), null);
});

test('labels: nothing before the word, nothing decided in the first part, the command after, nothing after the tail', () => {
  const clip = { start: 16000, end: 24000 }, { labels, valid } = labelFrames(300, clip, 2, 90, 150);
  const frameEnding = ms => Math.round((ms / 1000 * 16000 - 400) / 160);
  assert.equal(labels[frameEnding(500)], 0); assert.equal(valid[frameEnding(500)], 1);
  assert.equal(valid[frameEnding(1050)], 0, 'first 90 ms of the word are not labelled');
  assert.equal(labels[frameEnding(1300)], 2);
  assert.equal(labels[frameEnding(1800)], 0); assert.equal(valid[frameEnding(1800)], 1);
});

test('network learns XOR-like data and survives a JSON round trip', () => {
  const model = new Mlp([2, 16, 2], 4), trainer = new Trainer(model, { learningRate: 0.02, dropout: 0, smoothing: 0 });
  const points = [[0, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0]];
  for (let i = 0; i < 600; i++) trainer.step(points.map(([a, b, label]) => ({ x: Float32Array.from([a, b]), label, weight: 1 })));
  for (const [a, b, label] of points) { const p = model.forward(Float32Array.from([a, b])); assert.ok(p[label] > 0.9, `${a}${b}: ${p[label]}`); }
  const copy = Mlp.fromJson(JSON.parse(JSON.stringify(model.toJson())));
  assert.deepEqual(Array.from(copy.forward(Float32Array.from([1, 0]))), Array.from(model.forward(Float32Array.from([1, 0]))));
});

test('firer: needs the hold, fires once per word, rearms after the word is gone, honours the refractory time', () => {
  const feed = createFirer({ classes: 3, threshold: 0.9, hold: 2, refractoryFrames: 20, releaseFrames: 3 });
  const high = [0.05, 0.95, 0.0], low = [0.98, 0.01, 0.01];
  let frame = 0; const fired = [];
  const run = (probs, count) => { for (let i = 0; i < count; i++, frame++) { const c = feed(probs, frame); if (c > 0) fired.push(frame); } };
  run(low, 5); run(high, 1); assert.deepEqual(fired, [], 'one frame is not enough');
  run(high, 10); assert.equal(fired.length, 1, 'one firing for a long word');
  run(low, 5); run(high, 3); assert.equal(fired.length, 1, 'refractory time not over yet');
  run(low, 20); run(high, 3); assert.equal(fired.length, 2, 'fires again for the next word');
});

// one trained model shared by the next tests
const random = createRandom(21), clips = [];
for (const name of Object.keys(WORDS)) for (let i = 0; i < 24; i++) { const samples = take(name, random), span = dsp.segmentWord(samples); clips.push({ word: name, samples, start: span.start, end: span.end }); }
let json = null;
const progress = [];
test('training on synthetic words gives a model that finds them early and ignores other sounds', () => {
  json = trainClassifier({ clips, background: [background(80, random)], options: { epochs: 7, windowsPerEpoch: 9000, augmentClips: 4, augmentBackground: 2 }, onProgress: p => progress.push(p.stage) });
  assert.deepEqual(json.words, Object.keys(WORDS).sort());
  assert.ok(progress.includes('train') && progress.includes('evaluate'));
  const row = json.report.rows.find(r => r.threshold === json.threshold);
  assert.ok(row.detected >= 0.9, `detected ${row.detected}`);
  assert.ok(row.wrong <= 0.05, `wrong ${row.wrong}`);
  assert.ok(row.latencyMedianMs < 220, `latency ${row.latencyMedianMs} ms from the start of the word`);
});

test('streaming detector: finds each word in a stream, in chunks, at another sample rate, and does not repeat', () => {
  const model = loadModel(JSON.parse(JSON.stringify(json))), detector = new ClassifierDetector(model);
  const testRandom = createRandom(99); let correct = 0, total = 0;
  for (const name of Object.keys(WORDS)) {
    detector.reset();
    const samples = take(name, testRandom), at48 = dsp.resample(samples, RATE, 48000); // up to 48 kHz: it has to be resampled back inside
    const events = [];
    for (let at = 0; at < at48.length; at += 480) events.push(...detector.push(at48.subarray(at, at + 480), 48000));
    total++; if (events.length === 1 && events[0].word === name) correct++;
  }
  assert.ok(correct >= 3, `${correct} of ${total} words found exactly once`);
});

test('streaming detector stays silent on noise and unrelated sounds', () => {
  const model = loadModel(JSON.parse(JSON.stringify(json))), detector = new ClassifierDetector(model, { threshold: Math.max(json.threshold, 0.9) });
  const noise = new Float32Array(RATE * 20).map(() => createRandom(5).normal() * 0.01), rnd = createRandom(8);
  for (let i = 0; i < noise.length; i++) noise[i] = rnd.normal() * 0.01;
  let events = 0; for (let at = 0; at < noise.length; at += 160) events += detector.push(noise.subarray(at, at + 160)).length;
  assert.equal(events, 0);
});

test('model files: the format is checked and the model survives JSON', () => {
  assert.throws(() => loadModel({ format: 'other' }), /классификатора/);
  const a = loadModel(json), b = loadModel(JSON.parse(JSON.stringify(json)));
  const x = new Float32Array(a.frames * 32).fill(0.1);
  assert.deepEqual(Array.from(a.mlp.forward(x)), Array.from(b.mlp.forward(x)));
});

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('GRU runtime reproduces PyTorch (fixture from tools/ml/make_gru_fixture.py)', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'gru-parity.json'), 'utf8')), model = loadModel(fixture.model);
  model.net.reset();
  let worst = 0;
  fixture.frames.forEach((frame, i) => { const probs = model.net.step(Float32Array.from(frame)); fixture.probs[i].forEach((expected, c) => { worst = Math.max(worst, Math.abs(probs[c] - expected)); }); });
  assert.ok(worst < 1e-5, `largest difference ${worst}`);
});

test('GRU model in the streaming detector: state is kept between chunks and cleared by reset', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'gru-parity.json'), 'utf8')), model = loadModel(fixture.model);
  const audio = Float32Array.from({ length: RATE }, (_, i) => 0.2 * Math.sin(i / 9) * Math.sin(i / 2000));
  const run = chunk => { const stream = new (require('../src/classifier/detector').ClassifierStream)(model); const out = []; for (let at = 0; at < audio.length; at += chunk) out.push(...stream.push(audio.subarray(at, at + chunk), RATE)); return out; };
  const a = run(160), b = run(1000);
  assert.equal(a.length, b.length);
  a.forEach((item, i) => item.probs.forEach((p, c) => assert.ok(Math.abs(p - b[i].probs[c]) < 1e-6)));
  assert.throws(() => loadModel({ format: 'voice-keys-classifier', version: 2, arch: 'lstm', mels: 32 }), /Неизвестное устройство/);
});

const python = path.join(__dirname, '..', 'data', 'ml', 'venv', 'Scripts', 'python.exe');
test('Python training code gives the same numbers as the JavaScript signal chain', { skip: !fs.existsSync(python) && 'Python environment not installed (npm run setup-ml)' }, () => {
  const out = execFileSync(python, [path.join(__dirname, '..', 'tools', 'ml', 'test_parity.py')], { encoding: 'utf8', timeout: 120000 });
  assert.match(out, /resample 44100.*ok/); assert.match(out, /resample 48000.*ok/); assert.match(out, /log-mel.*ok/);
});
