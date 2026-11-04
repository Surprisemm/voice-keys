'use strict';
// Runs the personal classifier off the main thread: audio blocks in, "this command was spoken" events out.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { loadModel, ClassifierDetector } = require('./detector');

let detector = null, epoch = 0, active = false;
try {
  const model = loadModel(JSON.parse(fs.readFileSync(workerData.modelFile, 'utf8')));
  detector = new ClassifierDetector(model, { threshold: workerData.threshold ?? model.threshold });
  parentPort.postMessage({ type: 'ready', words: model.words, threshold: detector.threshold, arch: model.net ? 'gru' : 'mlp' });
} catch (error) { parentPort.postMessage({ type: 'error', message: error.message }); }

parentPort.on('message', message => {
  try {
    if (!detector) return;
    if (message.type === 'start') { epoch = message.epoch; active = true; detector.reset(); return; }
    if (message.type === 'stop') { active = false; detector.reset(); return; }
    if (message.type !== 'audio' || !active || message.epoch !== epoch) return;
    const started = performance.now(), events = detector.push(message.samples, message.sampleRate), processMs = performance.now() - started;
    for (const event of events) parentPort.postMessage({ type: 'fire', epoch, ...event, processMs });
  } catch (error) { parentPort.postMessage({ type: 'error', message: error.message }); }
});
