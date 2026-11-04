'use strict';
// Built-in (JavaScript) training, used when the Python environment is not installed. Runs off the main thread.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { loadDataset, trainClassifier } = require('./train');

try {
  const data = loadDataset(workerData.dataDir, workerData.words || null);
  if (!data.clips.length) throw new Error('Нет записей команд.');
  const model = trainClassifier({ clips: data.clips, background: data.background, options: workerData.options || {}, onProgress: progress => parentPort.postMessage({ type: 'progress', ...progress }) });
  fs.writeFileSync(workerData.out, JSON.stringify(model));
  parentPort.postMessage({ type: 'done', threshold: model.threshold, rows: model.report.rows });
} catch (error) { parentPort.postMessage({ type: 'error', message: error.message }); }
