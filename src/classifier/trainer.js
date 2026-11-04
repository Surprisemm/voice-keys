'use strict';
// Starts training of the personal classifier: PyTorch in the Python environment if it is installed, otherwise the built-in JavaScript trainer.
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { venvPython, installed } = require('../ml-setup');
const { loadModel } = require('./detector');

// quality -> PyTorch steps / JavaScript epochs
const QUALITY = { fast: { steps: 1200, epochs: 10 }, normal: { steps: 3000, epochs: 18 }, best: { steps: 6000, epochs: 30 } };

// words: the library words this network is trained on (default: all of them)
function startTraining({ dataDir, modelFile, mlDir, scriptsDir, words = null, quality = 'normal', forceBuiltIn = false, steps, epochs, onProgress = () => {} }) {
  const setting = { ...(QUALITY[quality] || QUALITY.normal), ...(steps ? { steps } : {}), ...(epochs ? { epochs } : {}) }, temporary = `${modelFile}.training`; // steps/epochs override: tests
  const usePython = !forceBuiltIn && installed(mlDir) && fs.existsSync(path.join(scriptsDir, 'train_classifier.py'));
  let child = null, worker = null, cancelled = false;
  fs.mkdirSync(path.dirname(modelFile), { recursive: true });
  fs.rmSync(temporary, { force: true });

  const finish = summary => {
    const json = JSON.parse(fs.readFileSync(temporary, 'utf8'));
    loadModel(json); // refuses a broken file before it replaces the working model
    fs.renameSync(temporary, modelFile);
    return { engine: usePython ? 'python' : 'js', ...summary };
  };
  const promise = new Promise((resolve, reject) => {
    if (usePython) {
      child = spawn(venvPython(mlDir), [path.join(scriptsDir, 'train_classifier.py'), dataDir, '--out', temporary, '--steps', String(setting.steps), '--jsonl', ...(words ? ['--words', words.join(',')] : [])], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      let buffer = '', failure = '', summary = null, stderrTail = '';
      child.stdout.on('data', data => {
        buffer += data;
        let at; while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
          if (!line) continue;
          try { const message = JSON.parse(line); if (message.type === 'error') failure = message.message; else if (message.type === 'done') summary = { threshold: message.threshold, rows: message.rows, seconds: message.seconds }; onProgress({ stage: message.type, ...message }); } catch { /* not JSON: a stray library message */ }
        }
      });
      child.stderr.on('data', data => { stderrTail = (stderrTail + data).slice(-500); });
      child.once('error', reject);
      child.once('exit', code => {
        if (cancelled) { fs.rmSync(temporary, { force: true }); reject(new Error('Обучение отменено.')); return; }
        // Python sometimes crashes while shutting CUDA down, after the model is written and 'done' is sent: that is not a failure.
        if (!summary) { reject(new Error(failure || `Обучение остановилось (код ${code}). ${stderrTail.trim().split('\n').slice(-2).join(' ')}`)); return; }
        try { resolve(finish(summary)); } catch (error) { reject(error); }
      });
    } else {
      worker = new Worker(path.join(__dirname, 'train-worker.js'), { workerData: { dataDir, words, out: temporary, options: { epochs: setting.epochs } } });
      let summary = null;
      worker.on('message', message => {
        if (message.type === 'progress') onProgress({ ...message, type: 'progress', step: message.epoch, steps: message.epochs });
        else if (message.type === 'done') { summary = { threshold: message.threshold, rows: message.rows }; onProgress({ type: 'done', message: 'Готово' }); }
        else if (message.type === 'error') { reject(new Error(message.message)); }
      });
      worker.once('error', reject);
      worker.once('exit', () => { if (cancelled) { fs.rmSync(temporary, { force: true }); reject(new Error('Обучение отменено.')); } else if (summary) { try { resolve(finish(summary)); } catch (error) { reject(error); } } });
    }
  });
  const cancel = () => { cancelled = true; try { child?.kill(); } catch { /* gone */ } worker?.terminate(); };
  return { engine: usePython ? 'python' : 'js', promise, cancel };
}
module.exports = { startTraining, QUALITY };
