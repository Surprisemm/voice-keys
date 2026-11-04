'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
let recognizer, stream, epoch = 0, segmentId = 0, lastText = '', sampleRate = 16000;
function emit(type, text, decodeMs) { parentPort.postMessage({ type: 'recognition', value: { type, text, words: [], epoch, segmentId, decodeMs, modelId: 'sherpa' } }); }
try {
  const sherpa = require('sherpa-onnx-node');
  recognizer = new sherpa.OnlineRecognizer({
    modelConfig: { toneCtc: { model: path.join(workerData.directory, 'model.onnx') }, tokens: path.join(workerData.directory, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 },
    decodingMethod: 'greedy_search', enableEndpoint: true,
    rule1MinTrailingSilence: 1.2, rule2MinTrailingSilence: workerData.speechEndMs / 1000, rule3MinUtteranceLength: 15
  });
  parentPort.postMessage({ type: 'ready' });
} catch (error) { parentPort.postMessage({ type: 'error', message: error.message, stack: error.stack }); }
parentPort.on('message', message => {
  try {
    if (!recognizer) return;
    if(message.type==='benchmark'){
      const start=performance.now(),testStream=recognizer.createStream();
      testStream.acceptWaveform({sampleRate:message.sampleRate,samples:message.samples});testStream.acceptWaveform({sampleRate:message.sampleRate,samples:new Float32Array(Math.round(message.sampleRate*.8))});testStream.inputFinished();
      while(recognizer.isReady(testStream))recognizer.decode(testStream);
      parentPort.postMessage({type:'benchmark-result',requestId:message.requestId,result:{recognizedText:recognizer.getResult(testStream).text.trim().toLowerCase(),decodeMs:performance.now()-start}});return;
    }
    if (message.type === 'start') { stream = recognizer.createStream(); epoch = message.epoch; segmentId = 0; lastText = ''; sampleRate = 16000; return; }
    if (message.type === 'stop') { stream = null; return; }
    if (!stream || message.epoch !== epoch) return;
    const start = performance.now();
    if (message.type === 'audio') {
      sampleRate = message.sampleRate;
      stream.acceptWaveform({ sampleRate: message.sampleRate, samples: message.samples });
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      const text = recognizer.getResult(stream).text.trim().toLowerCase();
      if (text !== lastText) { lastText = text; emit('partial', text, performance.now() - start); }
      if (recognizer.isEndpoint(stream)) { emit('final', text, performance.now() - start); recognizer.reset(stream); segmentId++; lastText = ''; }
    } else if (message.type === 'finish' || message.type === 'flush') {
      stream.acceptWaveform({ sampleRate, samples: new Float32Array(Math.round(sampleRate * 0.8)) }); stream.inputFinished();
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      emit('final', recognizer.getResult(stream).text.trim().toLowerCase(), performance.now() - start);
      stream = message.type === 'flush' ? recognizer.createStream() : null; segmentId++; lastText = '';
    }
  } catch (error) { parentPort.postMessage({ type: 'error', message: error.message, stack: error.stack }); }
});
