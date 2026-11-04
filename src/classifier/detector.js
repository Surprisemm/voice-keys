'use strict';
// Streaming use of a trained classifier: audio in, "this command was just spoken" events out.
const { RATE, MELS, HOP, Resampler, FeatureStream } = require('./dsp');
const { Mlp } = require('./model');
const { GruNet } = require('./gru');

const FORMAT = 'voice-keys-classifier';

// Turns the model file (JSON) into a ready object. Version 1: window network trained by the built-in JavaScript trainer.
// Version 2: GRU trained with PyTorch.
function loadModel(json) {
  if (!json || json.format !== FORMAT || ![1, 2].includes(json.version)) throw new Error('Это не файл классификатора Voice Keys.');
  if (json.version === 2 && (json.arch !== 'gru' || json.mels !== MELS)) throw new Error('Неизвестное устройство сети в файле классификатора.');
  const common = { ...json, mean: Float32Array.from(json.mean), std: Float32Array.from(json.std) };
  if (json.version === 2) {
    return { ...common, net: new GruNet(json.net, json.mels, json.hidden) };
  }
  return { ...common, mlp: Mlp.fromJson(json.mlp) };
}

// Audio -> class probabilities, one vector per 10 ms. Class 0 is "no command", classes 1..n are model.words.
class ClassifierStream {
  constructor(model) {
    this.model = model;
    if (!model.net) { this.span = (model.frames - 1) * model.stride + 1; this.input = new Float32Array(model.frames * MELS); }
    this.reset();
  }
  reset() { this.resampler = null; this.rate = 0; this.features = new FeatureStream(); this.ring = []; this.frame = 0; this.model.net?.reset(); }
  push(samples, rate = RATE) {
    if (rate !== this.rate) { this.resampler = new Resampler(rate, RATE); this.rate = rate; }
    const out = [], { mean, std, frames, stride, mlp, net } = this.model;
    for (const raw of this.features.push(this.resampler.push(samples))) {
      const normalized = new Float32Array(MELS);
      for (let m = 0; m < MELS; m++) normalized[m] = (raw[m] - mean[m]) / std[m];
      if (net) { out.push({ frame: this.frame++, probs: Float32Array.from(net.step(normalized)) }); continue; }
      this.ring.push(normalized); if (this.ring.length > this.span) this.ring.shift();
      for (let k = 0; k < frames; k++) {
        // oldest to newest; before the stream has enough history the first frame stands in, as in training
        const back = (frames - 1 - k) * stride, at = this.ring.length - 1 - back;
        this.input.set(this.ring[at >= 0 ? at : 0], k * MELS);
      }
      out.push({ frame: this.frame++, probs: Float32Array.from(mlp.forward(this.input)) });
    }
    return out;
  }
}

// Decides when a probability vector means "fire". A class fires once its probability stays at or above the threshold for `hold`
// frames; it can fire again only after it has dropped away (the word ended) and the refractory time has passed.
function createFirer({ classes, threshold = 0.9, hold = 2, refractoryFrames = 35, releaseProbability = 0.3, releaseFrames = 5 }) {
  const run = new Int32Array(classes), low = new Int32Array(classes), armed = new Uint8Array(classes).fill(1), last = new Int32Array(classes).fill(-1e9);
  return function feed(probs, frame) {
    let best = -1;
    for (let c = 1; c < classes; c++) {
      run[c] = probs[c] >= threshold ? run[c] + 1 : 0;
      low[c] = probs[c] < releaseProbability ? low[c] + 1 : 0;
      if (!armed[c] && low[c] >= releaseFrames && frame - last[c] >= refractoryFrames) armed[c] = 1;
      if (armed[c] && run[c] >= hold && (best < 0 || probs[c] > probs[best])) best = c;
    }
    if (best > 0) { armed[best] = 0; last[best] = frame; }
    return best;
  };
}

// Stream plus firer: push audio, get [{word, probability, frame, ms}] events. `ms` is the position in the pushed audio at the end of the firing frame.
class ClassifierDetector {
  constructor(model, options = {}) {
    this.model = model; this.stream = new ClassifierStream(model); this.options = options;
    this.threshold = options.threshold ?? model.threshold ?? 0.9;
    this.reset();
  }
  reset() { this.stream.reset(); this.firer = createFirer({ classes: this.model.words.length + 1, threshold: this.threshold, hold: this.options.hold ?? this.model.hold ?? 2, refractoryFrames: this.options.refractoryFrames ?? 35 }); }
  setThreshold(value) { this.threshold = value; const frame = this.stream.frame; this.firer = createFirer({ classes: this.model.words.length + 1, threshold: value, hold: this.options.hold ?? this.model.hold ?? 2, refractoryFrames: this.options.refractoryFrames ?? 35 }); this.firer.frame = frame; }
  push(samples, rate = RATE) {
    const events = [];
    for (const { frame, probs } of this.stream.push(samples, rate)) {
      const c = this.firer(probs, frame);
      if (c > 0) events.push({ word: this.model.words[c - 1], probability: probs[c], frame, ms: (frame * HOP + 400) / RATE * 1000 });
    }
    return events;
  }
}
module.exports = { FORMAT, loadModel, ClassifierStream, ClassifierDetector, createFirer };
