'use strict';
// Training of the personal command classifier from the user's own recordings. Pure JavaScript, runs in a worker thread or a script.
//
// Data: clips of single words (each is cut to the spoken part by energy) and background recordings (speech, game sound, keyboard, silence).
// Every clip is multiplied by augmentation (speed, volume, noise, background mixed in). Each 10 ms frame of a recording gets a label:
// the command once `tauMs` of the word have been heard, "no command" before the word and after it, and no label inside the first
// `tauMs` of the word. That is what makes the classifier decide early without being asked to know a word from nothing.
const fs = require('node:fs');
const path = require('node:path');
const { RATE, FRAME, HOP, MELS, readWav, resample, logMel, segmentWord } = require('./dsp');
const { Mlp, Trainer, createRandom } = require('./model');
const { FORMAT, loadModel, ClassifierStream, createFirer } = require('./detector');

const FRAMES = 15, STRIDE = 2, HIDDEN = [96, 48];
const DEFAULTS = { tauMs: 90, tailMs: 150, epochs: 18, windowsPerEpoch: 30000, positiveShare: 0.4, batch: 64, augmentClips: 10, augmentBackground: 3, learningRate: 0.002, dropout: 0.15, seed: 11, holdout: 0.15, hold: 2 };

const mean = list => list.reduce((s, v) => s + v, 0) / (list.length || 1);
const percentile = (list, p) => { if (!list.length) return null; const a = [...list].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };

// ---------- loading ----------
// dir/words/<word>/*.wav (one word per file) and dir/background/*.wav
// `only`: names of the words to load; the rest of the library is ignored (a network of one profile)
function loadDataset(dir, only = null) {
  const clips = [], skipped = [], background = [];
  const wordsDir = path.join(dir, 'words');
  if (fs.existsSync(wordsDir)) for (const word of fs.readdirSync(wordsDir)) {
    const folder = path.join(wordsDir, word); if (!fs.statSync(folder).isDirectory() || (only && !only.includes(word))) continue;
    for (const file of fs.readdirSync(folder).filter(name => /\.wav$/i.test(name)).sort()) {
      const wav = readWav(fs.readFileSync(path.join(folder, file))), samples = resample(wav.samples, wav.rate, RATE), span = segmentWord(samples);
      if (!span || span.end - span.start < RATE * 0.12 || span.end - span.start > RATE * 1.6) { skipped.push(`${word}/${file}`); continue; }
      clips.push({ word, samples, start: span.start, end: span.end, file: `${word}/${file}` });
    }
  }
  const backgroundDir = path.join(dir, 'background');
  if (fs.existsSync(backgroundDir)) for (const file of fs.readdirSync(backgroundDir).filter(name => /\.wav$/i.test(name)).sort()) {
    const wav = readWav(fs.readFileSync(path.join(backgroundDir, file))); background.push(resample(wav.samples, wav.rate, RATE));
  }
  return { clips, skipped, background };
}

// ---------- augmentation ----------
function coloredNoise(length, sigma, random) {
  const out = new Float32Array(length), alpha = 0.2 + 0.75 * random.uniform(); let state = 0;
  for (let i = 0; i < length; i++) { state = alpha * state + (1 - alpha) * random.normal(); out[i] = state * sigma / Math.sqrt((1 - alpha) / (1 + alpha)); }
  return out;
}
const rms = (x, from = 0, to = x.length) => { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, to - from)); };
function snippet(pool, length, random) {
  const out = new Float32Array(length); if (!pool.length) return out;
  const source = pool[random.int(pool.length)]; let at = random.int(Math.max(1, source.length));
  for (let i = 0; i < length; i++) { out[i] = source[at]; at = (at + 1) % source.length; }
  return out;
}
// One augmented copy of a clip: random speed, volume, noise floor, a background snippet, silence around the word.
function augmentClip(clip, random, pool, mild = false) {
  const speed = mild ? 0.97 + 0.06 * random.uniform() : 0.88 + 0.24 * random.uniform();
  const body = Math.abs(speed - 1) < 0.005 ? clip.samples : resample(clip.samples, Math.round(RATE * speed), RATE);
  const start = Math.round(clip.start / speed), end = Math.round(clip.end / speed);
  const lead = Math.round(RATE * (0.35 + 0.55 * random.uniform())), trail = Math.round(RATE * (0.35 + 0.35 * random.uniform()));
  const out = new Float32Array(lead + body.length + trail);
  const gain = Math.pow(10, (mild ? -4 + 8 * random.uniform() : -16 + 24 * random.uniform()) / 20);
  for (let i = 0; i < body.length; i++) out[lead + i] = body[i] * gain;
  const speech = Math.max(rms(out, lead + start, lead + end), 1e-4);
  const floor = coloredNoise(out.length, Math.pow(10, (mild ? -3.6 : -4 + 1.8 * random.uniform())), random);
  for (let i = 0; i < out.length; i++) out[i] += floor[i];
  if (pool.length && random.uniform() < (mild ? 0.4 : 0.65)) {
    const mix = snippet(pool, out.length, random), level = speech * Math.pow(10, -(mild ? 12 + 12 * random.uniform() : 2 + 23 * random.uniform()) / 20) / Math.max(rms(mix), 1e-5);
    for (let i = 0; i < out.length; i++) out[i] += mix[i] * level;
  }
  return { samples: out, start: lead + start, end: lead + end };
}
function augmentBackground(samples, random, pool) {
  const speed = 0.9 + 0.2 * random.uniform(), body = resample(samples, Math.round(RATE * speed), RATE), gain = Math.pow(10, (-18 + 26 * random.uniform()) / 20);
  const out = new Float32Array(body.length);
  for (let i = 0; i < out.length; i++) out[i] = body[i] * gain;
  const floor = coloredNoise(out.length, Math.pow(10, -4 + 1.8 * random.uniform()), random);
  for (let i = 0; i < out.length; i++) out[i] += floor[i];
  return out;
}

// ---------- sequences and windows ----------
function labelFrames(count, clip, classIndex, tauMs, tailMs) {
  const labels = new Uint8Array(count), valid = new Uint8Array(count).fill(1), tau = tauMs * RATE / 1000, tail = tailMs * RATE / 1000;
  if (!clip) return { labels, valid };
  for (let f = 0; f < count; f++) {
    const e = f * HOP + FRAME; // newest sample of the window ending at this frame
    if (e >= clip.start + tau && e <= clip.end + tail) labels[f] = classIndex;
    else if (e >= clip.start && e < clip.start + tau) valid[f] = 0;
  }
  return { labels, valid };
}
function buildWindow(frames, f, out) {
  for (let k = 0; k < FRAMES; k++) { const at = f - (FRAMES - 1 - k) * STRIDE; out.set(frames[at >= 0 ? at : 0], k * MELS); }
}

// ---------- evaluation with the real streaming detector ----------
function detectionRun(model, audio) {
  const stream = new ClassifierStream(model), probs = [];
  for (let at = 0; at < audio.length; at += 1600) for (const item of stream.push(audio.subarray(at, Math.min(audio.length, at + 1600)), RATE)) probs.push(item.probs);
  return probs;
}
function firesFor(probs, classes, threshold, hold) {
  const feed = createFirer({ classes, threshold, hold }), out = [];
  probs.forEach((p, frame) => { const c = feed(p, frame); if (c > 0) out.push({ c, frame, ms: (frame * HOP + FRAME) / RATE * 1000 }); });
  return out;
}
// clips: held-out clips; backgroundAudio: held-out background arrays. Returns one row per threshold.
function evaluate(model, clips, backgroundAudio, pool, thresholds, random) {
  const classes = model.words.length + 1, runs = [];
  for (const clip of clips) for (let variant = 0; variant < 3; variant++) {
    const aug = variant === 0 ? { samples: padded(clip), start: Math.round(RATE * 0.8) + clip.start, end: Math.round(RATE * 0.8) + clip.end } : augmentClip(clip, random, pool, true);
    runs.push({ word: clip.word, start: aug.start / RATE * 1000, end: aug.end / RATE * 1000, probs: detectionRun(model, aug.samples) });
  }
  const background = backgroundAudio.map(audio => ({ seconds: audio.length / RATE, probs: detectionRun(model, audio) }));
  return thresholds.map(threshold => {
    let found = 0, wrong = 0, spurious = 0; const latency = [];
    for (const run of runs) {
      const events = firesFor(run.probs, classes, threshold, model.hold);
      const inside = events.filter(e => e.ms >= run.start && e.ms <= run.end + 400), outside = events.length - inside.length;
      if (inside.length) { if (model.words[inside[0].c - 1] === run.word) { found++; latency.push(inside[0].ms - run.start); } else wrong++; }
      spurious += outside + Math.max(0, inside.length - 1);
    }
    let backgroundFalse = 0, seconds = 0;
    for (const item of background) { backgroundFalse += firesFor(item.probs, classes, threshold, model.hold).length; seconds += item.seconds; }
    return { threshold, clips: runs.length, detected: found / Math.max(1, runs.length), wrong: wrong / Math.max(1, runs.length), spuriousPerClip: spurious / Math.max(1, runs.length), backgroundFalse, backgroundSeconds: seconds, latencyMedianMs: percentile(latency, 0.5), latencyP90Ms: percentile(latency, 0.9) };
  });
}
function padded(clip) {
  const out = new Float32Array(Math.round(RATE * 0.8) + clip.samples.length + Math.round(RATE * 0.8)); out.set(clip.samples, Math.round(RATE * 0.8));
  for (let i = 0; i < out.length; i++) out[i] += (((i * 2654435761) >>> 0) / 4294967296 - 0.5) * 0.0006;
  return out;
}
function pickThreshold(rows) {
  const clean = rows.filter(r => r.backgroundFalse === 0 && r.wrong <= 0.02 && r.spuriousPerClip <= 0.05);
  const pool = clean.length ? clean : rows;
  return pool.reduce((best, r) => (r.detected - 0.3 * r.wrong - r.backgroundFalse * 0.5 > best.detected - 0.3 * best.wrong - best.backgroundFalse * 0.5 + 1e-9 || (Math.abs(r.detected - best.detected) < 1e-9 && r.latencyMedianMs < best.latencyMedianMs)) ? r : best).threshold;
}

// ---------- training ----------
function trainClassifier({ clips, background = [], options = {}, onProgress = () => {}, shouldStop = () => false }) {
  const opt = { ...DEFAULTS, ...options }, random = createRandom(opt.seed);
  const words = [...new Set(clips.map(c => c.word))].sort();
  if (!words.length) throw new Error('Нет записей команд.');
  // hold out whole takes for validation (same split every time)
  const train = [], held = [];
  for (const word of words) {
    const list = clips.filter(c => c.word === word), count = list.length >= 6 ? Math.max(1, Math.round(list.length * opt.holdout)) : 0;
    const order = list.map((_, i) => i).sort((a, b) => ((a * 2654435761 + opt.seed) >>> 0) - ((b * 2654435761 + opt.seed) >>> 0));
    list.forEach((clip, i) => (order.indexOf(i) < count ? held : train).push(clip));
  }
  const pool = [], backgroundTrain = [], backgroundHeld = [];
  background.forEach((audio, i) => { for (let at = 0; at < audio.length; at += RATE * 6) { const part = audio.subarray(at, Math.min(audio.length, at + RATE * 6)); if (part.length < RATE) continue; ((Math.floor(at / (RATE * 6)) + i) % 7 === 0 ? backgroundHeld : backgroundTrain).push(part); } });
  backgroundTrain.forEach(part => pool.push(part));
  onProgress({ stage: 'prepare', message: `Готовлю данные: ${train.length} записей, ${held.length} для проверки, фон ${Math.round(backgroundTrain.reduce((s, p) => s + p.length, 0) / RATE)} с` });

  // sequences of raw log-mel frames with labels
  const sequences = [], add = (samples, clip, classIndex) => { const frames = logMel(samples), { labels, valid } = labelFrames(frames.length, clip, classIndex, opt.tauMs, opt.tailMs); sequences.push({ frames, labels, valid }); };
  for (const clip of train) for (let a = 0; a < opt.augmentClips; a++) { const aug = augmentClip(clip, random, pool); add(aug.samples, aug, words.indexOf(clip.word) + 1); }
  for (const part of backgroundTrain) for (let a = 0; a < opt.augmentBackground; a++) add(augmentBackground(part, random, pool), null, 0);
  // clips contribute their silent edges as background too; with no background recordings at all, make some from noise
  if (!backgroundTrain.length) for (let i = 0; i < 40; i++) add(coloredNoise(RATE * 4, Math.pow(10, -4 + 1.8 * random.uniform()), random), null, 0);
  if (shouldStop()) return null;

  // feature statistics over all frames, then normalise in place
  const sum = new Float64Array(MELS), sumSq = new Float64Array(MELS); let n = 0;
  for (const seq of sequences) for (const frame of seq.frames) { for (let m = 0; m < MELS; m++) { sum[m] += frame[m]; sumSq[m] += frame[m] * frame[m]; } n++; }
  const featureMean = Float32Array.from(sum, v => v / n), featureStd = Float32Array.from(sumSq, (v, m) => Math.sqrt(Math.max(v / n - featureMean[m] ** 2, 1e-4)));
  for (const seq of sequences) seq.frames = seq.frames.map(frame => { const out = new Float32Array(MELS); for (let m = 0; m < MELS; m++) out[m] = (frame[m] - featureMean[m]) / featureStd[m]; return out; });

  const positives = [], negatives = [];
  sequences.forEach((seq, s) => { for (let f = 0; f < seq.frames.length; f++) { if (!seq.valid[f]) continue; (seq.labels[f] > 0 ? positives : negatives).push(s * 65536 + f); } });
  onProgress({ stage: 'prepare', message: `Окон: ${positives.length} с командой, ${negatives.length} без команды` });

  const inputSize = FRAMES * MELS, classes = words.length + 1;
  const mlp = new Mlp([inputSize, ...HIDDEN, classes], opt.seed), trainer = new Trainer(mlp, { learningRate: opt.learningRate, dropout: opt.dropout, seed: opt.seed + 1 });
  const perEpochPositive = Math.min(Math.round(opt.windowsPerEpoch * opt.positiveShare), positives.length * 2), perEpochNegative = Math.min(opt.windowsPerEpoch - perEpochPositive, negatives.length * 2);
  const pickWindow = code => { const seq = sequences[Math.floor(code / 65536)], f = code % 65536, x = new Float32Array(inputSize); buildWindow(seq.frames, f, x); return { x, label: seq.labels[f], weight: 1 }; };
  let lastLoss = 0;
  for (let epoch = 1; epoch <= opt.epochs; epoch++) {
    trainer.learningRate = opt.learningRate * (0.1 + 0.9 * 0.5 * (1 + Math.cos(Math.PI * (epoch - 1) / opt.epochs)));
    const picks = [];
    for (let i = 0; i < perEpochPositive; i++) picks.push(positives[random.int(positives.length)]);
    for (let i = 0; i < perEpochNegative; i++) picks.push(negatives[random.int(negatives.length)]);
    for (let i = picks.length - 1; i > 0; i--) { const j = random.int(i + 1); [picks[i], picks[j]] = [picks[j], picks[i]]; }
    let loss = 0, batches = 0;
    for (let at = 0; at < picks.length; at += opt.batch) { loss += trainer.step(picks.slice(at, at + opt.batch).map(pickWindow)); batches++; if (shouldStop()) return null; }
    lastLoss = loss / batches;
    onProgress({ stage: 'train', epoch, epochs: opt.epochs, loss: lastLoss, message: `Эпоха ${epoch} из ${opt.epochs}, ошибка ${lastLoss.toFixed(3)}` });
  }

  const model = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), words, frames: FRAMES, stride: STRIDE, mels: MELS, mean: Array.from(featureMean), std: Array.from(featureStd), mlp: mlp.toJson(), threshold: 0.9, hold: opt.hold, tauMs: opt.tauMs, tailMs: opt.tailMs, trainedOn: { clips: train.length, held: held.length, backgroundSeconds: Math.round(backgroundTrain.reduce((s, p) => s + p.length, 0) / RATE) } };
  const ready = loadModel(model);
  onProgress({ stage: 'evaluate', message: 'Проверяю на записях, которых модель не видела' });
  const thresholds = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98];
  const rows = held.length ? evaluate(ready, held, backgroundHeld.length ? backgroundHeld : [coloredNoise(RATE * 20, 0.001, random)], pool, thresholds, random) : [];
  if (rows.length) model.threshold = pickThreshold(rows);
  model.report = { loss: lastLoss, rows, classes: words };
  return model;
}

module.exports = { DEFAULTS, FRAMES, STRIDE, loadDataset, trainClassifier, evaluate, augmentClip, labelFrames, buildWindow, detectionRun, firesFor, pickThreshold, mean, percentile };
