'use strict';
// GigaAM is an offline (whole-utterance) model. To act like a streaming one this worker keeps the audio of the
// current utterance, re-decodes it every INTERIM_MS of new speech and publishes the text as a partial result.
// The renderer's silence detector ends the utterance with 'flush' (or 'finish' on key release) and gets the final text.
const { parentPort, workerData } = require('node:worker_threads');
const INTERIM_MS = 60, PREROLL_MS = 300, MAX_SEGMENT_MS = 12000, VOICE_RMS = 0.003;
let recognizer, epoch = 0, segmentId = 0, active = false, speaking = false;
let chunks = [], bufferedSamples = 0, sampleRate = 16000, newSamples = 0, lastText = '', lastDecodeMs = 0;

function emit(type, text, decodeMs) { parentPort.postMessage({ type: 'recognition', value: { type, text, words: [], epoch, segmentId, decodeMs, modelId: 'gigaam' } }); }
function decode(samples, rate) {
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: rate, samples });
  recognizer.decode(stream);
  return recognizer.getResult(stream).text.trim().toLowerCase();
}
function joined() {
  const all = new Float32Array(bufferedSamples); let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.length; }
  return all;
}
function reset() { chunks = []; bufferedSamples = 0; newSamples = 0; lastText = ''; speaking = false; }
function finish() {
  if (!speaking) { reset(); return; }
  const started = performance.now(), text = decode(joined(), sampleRate);
  emit('final', text, performance.now() - started); segmentId++; reset();
}
function onAudio(message) {
  sampleRate = message.sampleRate;
  const samples = message.samples; let sum = 0; for (const sample of samples) sum += sample * sample;
  const loud = Math.sqrt(sum / samples.length) > VOICE_RMS;
  chunks.push(samples); bufferedSamples += samples.length;
  if (!speaking) {
    // Before speech starts only a short pre-roll is kept, so silence never accumulates.
    const keep = sampleRate * PREROLL_MS / 1000;
    while (chunks.length > 1 && bufferedSamples - chunks[0].length >= keep) bufferedSamples -= chunks.shift().length;
    if (!loud) return;
    speaking = true; newSamples = 0;
  }
  newSamples += samples.length;
  if (bufferedSamples > sampleRate * MAX_SEGMENT_MS / 1000) { finish(); return; }
  // Skip interim decoding when the model is slower than the audio, so the queue never grows.
  if (newSamples < sampleRate * Math.max(INTERIM_MS, lastDecodeMs * 1.5) / 1000) return;
  newSamples = 0;
  const started = performance.now(), text = decode(joined(), sampleRate);
  lastDecodeMs = performance.now() - started;
  if (text !== lastText) { lastText = text; emit('partial', text, lastDecodeMs); }
}

try {
  const sherpa = require('sherpa-onnx-node');
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 64 },
    modelConfig: { nemoCtc: { model: workerData.model }, tokens: workerData.tokens, numThreads: 2, provider: 'cpu', debug: 0 }
  });
  parentPort.postMessage({ type: 'ready' });
} catch (error) { parentPort.postMessage({ type: 'error', message: error.message, stack: error.stack }); }

parentPort.on('message', message => {
  try {
    if (!recognizer) return;
    if (message.type === 'benchmark') {
      const started = performance.now(), text = decode(message.samples, message.sampleRate);
      parentPort.postMessage({ type: 'benchmark-result', requestId: message.requestId, result: { recognizedText: text, decodeMs: performance.now() - started } }); return;
    }
    if (message.type === 'start') { epoch = message.epoch; segmentId = 0; active = true; lastDecodeMs = 0; reset(); return; }
    if (message.type === 'stop') { active = false; reset(); return; }
    if (!active || message.epoch !== epoch) return;
    if (message.type === 'audio') onAudio(message);
    else if (message.type === 'flush') finish();
    else if (message.type === 'finish') { finish(); active = false; }
  } catch (error) { parentPort.postMessage({ type: 'error', message: error.message, stack: error.stack }); }
});
