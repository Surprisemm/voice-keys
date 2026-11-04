'use strict';
// Trains the personal command classifier from a folder of recordings.
//   node scripts/classifier-train.js <dataDir> [--out model.json] [--tau 90] [--epochs 18]
// dataDir/words/<word>/*.wav   one spoken word per file (any sample rate, 16-bit)
// dataDir/background/*.wav     everything that is not a command: speech, game sound, keyboard, silence
const fs = require('node:fs');
const path = require('node:path');
const { loadDataset, trainClassifier } = require('../src/classifier/train');

const args = process.argv.slice(2), dir = args.find(arg => !arg.startsWith('--'));
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
if (!dir) { console.error('Использование: node scripts/classifier-train.js <папка> [--out model.json] [--tau 90] [--epochs 18]'); process.exit(1); }
const data = loadDataset(dir);
console.log(`Записей команд: ${data.clips.length}, слов: ${new Set(data.clips.map(c => c.word)).size}, фоновых файлов: ${data.background.length}${data.skipped.length ? `, пропущено без речи: ${data.skipped.join(', ')}` : ''}`);
const started = Date.now();
const model = trainClassifier({
  clips: data.clips, background: data.background,
  options: { tauMs: Number(option('tau', 90)), epochs: Number(option('epochs', 18)) },
  onProgress: p => console.log(p.message)
});
const out = option('out', path.join(dir, 'model.json'));
fs.writeFileSync(out, JSON.stringify(model));
console.log(`\nГотово за ${Math.round((Date.now() - started) / 1000)} с. Модель: ${out} (${Math.round(fs.statSync(out).size / 1024)} КБ), порог ${model.threshold}`);
if (model.report.rows.length) console.table(model.report.rows.map(r => ({ порог: r.threshold, найдено: r.detected.toFixed(2), 'не то слово': r.wrong.toFixed(2), 'лишних на запись': r.spuriousPerClip.toFixed(2), 'ложных на фоне': r.backgroundFalse, 'задержка мс (медиана)': r.latencyMedianMs && Math.round(r.latencyMedianMs), 'p90': r.latencyP90Ms && Math.round(r.latencyP90Ms) })));
