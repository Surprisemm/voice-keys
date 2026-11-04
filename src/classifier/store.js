'use strict';
// The classifier's files on disk: recordings of commands, background recordings, the trained model.
//   <dir>/words/<word>/<take>.wav     one spoken word, original sample rate, a little silence around it
//   <dir>/background/<id>.wav         anything that is not a command
//   <dir>/models/shared.json          the network for all profiles (see detector.js)
//   <dir>/models/<profile id>.json    the network of one profile
// The recordings are one library for every network. A network is trained on a chosen set of its words.
const fs = require('node:fs');
const path = require('node:path');
const { RATE, readWav, writeWav, resample, segmentWord } = require('./dsp');

const MAX_TAKES = 200, MAX_BACKGROUND_SECONDS = 600;

// One lower-case word without spaces; "ё" is "е", as in the rest of the app.
function cleanWord(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9-]/g, '').slice(0, 30);
}
const uniqueName = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function createClassifierStore(dir) {
  const wordsDir = path.join(dir, 'words'), backgroundDir = path.join(dir, 'background'), modelsDir = path.join(dir, 'models');
  const scopeName = scope => { const name = scope || 'shared'; if (!/^[a-zA-Z0-9-]{1,80}$/.test(name)) throw new Error('Некорректное имя модели.'); return name; };
  const modelPath = scope => path.join(modelsDir, `${scopeName(scope)}.json`);
  const modelFile = modelPath('shared');
  // before profiles had their own networks there was a single model.json: it becomes the shared network
  const legacyModel = path.join(dir, 'model.json');
  if (fs.existsSync(legacyModel)) { fs.mkdirSync(modelsDir, { recursive: true }); if (fs.existsSync(modelFile)) fs.rmSync(legacyModel, { force: true }); else fs.renameSync(legacyModel, modelFile); }
  const list = folder => fs.existsSync(folder) ? fs.readdirSync(folder).filter(name => /\.wav$/i.test(name)).sort() : [];
  const wordFolder = word => { const clean = cleanWord(word); if (!clean) throw new Error('Нужно одно слово из букв и цифр.'); return path.join(wordsDir, clean); };
  function seconds(file) { try { return Math.max(0, (fs.statSync(file).size - 44) / 2 / readHeaderRate(file)); } catch { return 0; } }
  function readHeaderRate(file) { const fd = fs.openSync(file, 'r'), head = Buffer.alloc(32); fs.readSync(fd, head, 0, 32, 0); fs.closeSync(fd); return head.readUInt32LE(24) || RATE; }

  // how many recordings of each word the network was trained on (to tell later that more were recorded)
  const takesPath = scope => path.join(modelsDir, `${scopeName(scope)}.takes`);
  const readTakes = scope => { try { return JSON.parse(fs.readFileSync(takesPath(scope), 'utf8')); } catch { return null; } };
  function saveTakes(scope, counts) { fs.mkdirSync(modelsDir, { recursive: true }); fs.writeFileSync(takesPath(scope), JSON.stringify(counts)); }
  function modelInfo(scope = 'shared') {
    const file = modelPath(scope);
    if (!fs.existsSync(file)) return null;
    try {
      const model = JSON.parse(fs.readFileSync(file, 'utf8')), rows = model.report?.rows || [], row = rows.find(r => r.threshold === model.threshold) || null;
      const takes = readTakes(scope);
      return { createdAt: model.createdAt, takes, words: model.words, version: model.version, arch: model.arch || 'mlp', threshold: model.threshold, trainedOn: model.trainedOn, row, sizeKb: Math.round(fs.statSync(file).size / 1024) };
    } catch { return { broken: true }; }
  }
  function status() {
    const words = {};
    if (fs.existsSync(wordsDir)) for (const name of fs.readdirSync(wordsDir)) {
      const folder = path.join(wordsDir, name); if (!fs.statSync(folder).isDirectory()) continue;
      words[name] = list(folder).length;
    }
    const background = list(backgroundDir);
    // model: the shared network; models: every network by its scope ('shared' or a profile id)
    const models = {};
    if (fs.existsSync(modelsDir)) for (const name of fs.readdirSync(modelsDir)) { const match = /^([a-zA-Z0-9-]{1,80}).json$/.exec(name); if (match) models[match[1]] = modelInfo(match[1]); }
    return { words, backgroundFiles: background.length, backgroundSeconds: Math.round(background.reduce((sum, name) => sum + seconds(path.join(backgroundDir, name)), 0)), model: models.shared || null, models };
  }
  // samples: Float32Array at `rate`. Checks that a word was really said, then stores it with 0.35 s of context on both sides.
  function addTake(word, samples, rate) {
    const folder = wordFolder(word);
    if (!(samples instanceof Float32Array) || !Number.isFinite(rate) || rate < 8000 || rate > 192000 || samples.length < rate * 0.3 || samples.length > rate * 6) return { ok: false, reason: 'Запись пуста или слишком длинная.' };
    const flat = resample(samples, rate, RATE), span = segmentWord(flat);
    if (!span) return { ok: false, reason: 'Речь не слышна: говорите громче или ближе к микрофону.' };
    const length = (span.end - span.start) / RATE * 1000;
    if (length < 120) return { ok: false, reason: 'Слишком короткий звук. Скажите слово целиком.' };
    if (length > 1600) return { ok: false, reason: 'Слишком долго. Произносите одно слово, без пауз.' };
    let peak = 0, clipped = 0; for (const value of samples) { const a = Math.abs(value); if (a > peak) peak = a; if (a > 0.985) clipped++; }
    if (peak < 0.03) return { ok: false, reason: 'Слишком тихо: подойдите ближе к микрофону или увеличьте его громкость.' };
    if (clipped > samples.length * 0.004) return { ok: false, reason: 'Звук перегружен: уменьшите громкость микрофона или говорите тише.' };
    if (list(folder).length >= MAX_TAKES) return { ok: false, reason: `Уже ${MAX_TAKES} записей этого слова.` };
    const scale = rate / RATE, from = Math.max(0, Math.round(span.start * scale - rate * 0.35)), to = Math.min(samples.length, Math.round(span.end * scale + rate * 0.35));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${uniqueName()}.wav`), writeWav(samples.subarray(from, to), rate));
    return { ok: true, count: list(folder).length, durationMs: Math.round(length), peak: Math.round(peak * 100) / 100 };
  }
  function addBackground(samples, rate) {
    if (!(samples instanceof Float32Array) || !Number.isFinite(rate) || rate < 8000 || rate > 192000 || samples.length < rate * 2) return { ok: false, reason: 'Запись фона слишком короткая.' };
    if (samples.length > rate * MAX_BACKGROUND_SECONDS) return { ok: false, reason: 'Запись фона слишком длинная.' };
    fs.mkdirSync(backgroundDir, { recursive: true });
    fs.writeFileSync(path.join(backgroundDir, `${uniqueName()}.wav`), writeWav(samples, rate));
    return { ok: true, seconds: Math.round(samples.length / rate) };
  }
  function removeLastTake(word) {
    const folder = wordFolder(word), files = list(folder);
    if (!files.length) return { ok: false };
    // names start with a base-36 timestamp, so the newest sorts last for equal lengths
    const newest = files.map(name => ({ name, time: fs.statSync(path.join(folder, name)).mtimeMs })).sort((a, b) => b.time - a.time)[0];
    fs.unlinkSync(path.join(folder, newest.name));
    if (!list(folder).length) fs.rmSync(folder, { recursive: true, force: true });
    return { ok: true };
  }
  const removeWord = word => { fs.rmSync(wordFolder(word), { recursive: true, force: true }); return { ok: true }; };
  const removeBackground = () => { fs.rmSync(backgroundDir, { recursive: true, force: true }); return { ok: true }; };
  const removeModel = (scope = 'shared') => { fs.rmSync(modelPath(scope), { force: true }); fs.rmSync(takesPath(scope), { force: true }); return { ok: true }; };
  function removeAll() { fs.rmSync(wordsDir, { recursive: true, force: true }); removeBackground(); fs.rmSync(modelsDir, { recursive: true, force: true }); return { ok: true }; }
  function saveModel(json, scope = 'shared') { const file = modelPath(scope); fs.mkdirSync(modelsDir, { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(json)); fs.renameSync(`${file}.tmp`, file); }
  const loadModelJson = (scope = 'shared') => fs.existsSync(modelPath(scope)) ? JSON.parse(fs.readFileSync(modelPath(scope), 'utf8')) : null;
  return { dir, wordsDir, backgroundDir, modelFile, modelPath, saveTakes, status, addTake, addBackground, removeLastTake, removeWord, removeBackground, removeModel, removeAll, saveModel, loadModelJson, modelInfo };
}
module.exports = { createClassifierStore, cleanWord, MAX_TAKES };
