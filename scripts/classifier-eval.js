'use strict';
// Runs a trained classifier over recordings and prints, per file, which command fired and how many ms after the word started.
//   node scripts/classifier-eval.js <model.json> <folder with words/<word>/*.wav> [--threshold 0.9]
const fs = require('node:fs');
const path = require('node:path');
const { readWav, resample, segmentWord, RATE } = require('../src/classifier/dsp');
const { loadModel, ClassifierDetector } = require('../src/classifier/detector');

const args = process.argv.slice(2), [modelFile, dir] = args.filter(arg => !arg.startsWith('--'));
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
if (!modelFile || !dir) { console.error('Использование: node scripts/classifier-eval.js <model.json> <папка> [--threshold 0.9]'); process.exit(1); }
const model = loadModel(JSON.parse(fs.readFileSync(modelFile, 'utf8')));
const threshold = Number(option('threshold', model.threshold)), rows = [];
const wordsDir = path.join(dir, 'words');
for (const word of fs.readdirSync(wordsDir)) for (const file of fs.readdirSync(path.join(wordsDir, word)).filter(name => /\.wav$/i.test(name))) {
  const wav = readWav(fs.readFileSync(path.join(wordsDir, word, file))), samples = resample(wav.samples, wav.rate, RATE), span = segmentWord(samples);
  if (!span) { rows.push({ файл: `${word}/${file}`, результат: 'нет речи' }); continue; }
  const detector = new ClassifierDetector(model, { threshold }), events = [];
  const audio = new Float32Array(samples.length + RATE); audio.set(samples);
  for (let at = 0; at < audio.length; at += 160) events.push(...detector.push(audio.subarray(at, at + 160), RATE));
  const startMs = span.start / RATE * 1000, first = events[0];
  rows.push({ файл: `${word}/${file}`, 'длина слова мс': Math.round((span.end - span.start) / RATE * 1000), сработало: events.map(e => `${e.word}@${Math.round(e.ms - startMs)}`).join(' ') || '—', верно: first ? (first.word === word ? 'да' : 'НЕТ') : 'не нашёл', 'через мс от начала': first ? Math.round(first.ms - startMs) : null, уверенность: first ? first.probability.toFixed(2) : null });
}
console.log(`Порог ${threshold}`); console.table(rows);
const ok = rows.filter(r => r.верно === 'да'); console.log(`Верно: ${ok.length} из ${rows.length}; медиана задержки: ${ok.length ? ok.map(r => r['через мс от начала']).sort((a, b) => a - b)[Math.floor(ok.length / 2)] : '—'} мс`);
