'use strict';
// A small fully connected network (ReLU hidden layers, softmax output) with its own Adam trainer. Plain typed arrays, no dependencies.

function createRandom(seed) {
  let state = seed >>> 0;
  const uniform = () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const normal = () => Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());
  return { uniform, normal, int: n => Math.floor(uniform() * n) };
}

class Mlp {
  constructor(sizes, seed = 1) {
    this.sizes = sizes; this.W = []; this.b = [];
    const random = createRandom(seed);
    for (let l = 0; l + 1 < sizes.length; l++) {
      const inputs = sizes[l], outputs = sizes[l + 1], w = new Float32Array(inputs * outputs), scale = Math.sqrt(2 / inputs);
      for (let i = 0; i < w.length; i++) w[i] = random.normal() * scale;
      this.W.push(w); this.b.push(new Float32Array(outputs));
    }
    this.buffers = sizes.slice(1).map(size => new Float32Array(size));
  }
  // Class probabilities for one input vector. The returned array is reused between calls.
  forward(x) {
    let input = x;
    for (let l = 0; l < this.W.length; l++) {
      const w = this.W[l], b = this.b[l], out = this.buffers[l], inputs = this.sizes[l], outputs = this.sizes[l + 1], last = l === this.W.length - 1;
      for (let o = 0; o < outputs; o++) {
        let acc = b[o]; const row = o * inputs;
        for (let i = 0; i < inputs; i++) acc += w[row + i] * input[i];
        out[o] = last ? acc : (acc > 0 ? acc : 0);
      }
      input = out;
    }
    const logits = input; let max = -Infinity; for (const value of logits) if (value > max) max = value;
    let sum = 0; for (let i = 0; i < logits.length; i++) { logits[i] = Math.exp(logits[i] - max); sum += logits[i]; }
    for (let i = 0; i < logits.length; i++) logits[i] /= sum;
    return logits;
  }
  toJson() {
    const encode = array => Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64');
    return { sizes: this.sizes, W: this.W.map(encode), b: this.b.map(encode) };
  }
  static fromJson(json) {
    const model = new Mlp(json.sizes, 1);
    const decode = text => { const bytes = Buffer.from(text, 'base64'), array = new Float32Array(bytes.length / 4); for (let i = 0; i < array.length; i++) array[i] = bytes.readFloatLE(i * 4); return array; };
    model.W = json.W.map(decode); model.b = json.b.map(decode);
    return model;
  }
}

// Mini-batch Adam with L2, dropout on hidden layers and label smoothing.
class Trainer {
  constructor(model, { learningRate = 0.002, l2 = 1e-4, dropout = 0.15, smoothing = 0.03, seed = 7 } = {}) {
    this.model = model; this.learningRate = learningRate; this.l2 = l2; this.dropout = dropout; this.smoothing = smoothing; this.random = createRandom(seed); this.steps = 0;
    const zeros = list => list.map(array => new Float32Array(array.length));
    this.gW = zeros(model.W); this.gb = zeros(model.b); this.mW = zeros(model.W); this.mb = zeros(model.b); this.vW = zeros(model.W); this.vb = zeros(model.b);
    this.acts = model.sizes.map(size => new Float32Array(size)); this.masks = model.sizes.map(size => new Float32Array(size));
    this.deltas = model.sizes.map(size => new Float32Array(size));
  }
  // batch: array of {x: Float32Array, label: int, weight: number}. Returns mean loss.
  step(batch) {
    const model = this.model, layers = model.W.length, classes = model.sizes[layers];
    for (let l = 0; l < layers; l++) { this.gW[l].fill(0); this.gb[l].fill(0); }
    let loss = 0, totalWeight = 0;
    for (const sample of batch) totalWeight += sample.weight;
    if (totalWeight <= 0) return 0;
    const keep = 1 - this.dropout;
    for (const sample of batch) {
      // forward with dropout, remembering activations
      this.acts[0] = sample.x;
      for (let l = 0; l < layers; l++) {
        const w = model.W[l], b = model.b[l], inputs = model.sizes[l], outputs = model.sizes[l + 1], out = this.acts[l + 1], input = this.acts[l], last = l === layers - 1, mask = this.masks[l + 1];
        for (let o = 0; o < outputs; o++) {
          let acc = b[o]; const row = o * inputs;
          for (let i = 0; i < inputs; i++) acc += w[row + i] * input[i];
          if (last) out[o] = acc;
          else if (acc > 0 && (this.dropout === 0 || this.random.uniform() < keep)) { out[o] = this.dropout === 0 ? acc : acc / keep; mask[o] = 1; }
          else { out[o] = 0; mask[o] = 0; }
        }
      }
      const logits = this.acts[layers]; let max = -Infinity; for (let i = 0; i < classes; i++) if (logits[i] > max) max = logits[i];
      let sum = 0; const probs = this.deltas[layers]; for (let i = 0; i < classes; i++) { probs[i] = Math.exp(logits[i] - max); sum += probs[i]; }
      const scale = sample.weight / totalWeight, smooth = this.smoothing / classes;
      for (let i = 0; i < classes; i++) {
        probs[i] /= sum;
        const target = (i === sample.label ? 1 - this.smoothing : 0) + smooth;
        loss -= scale * target * Math.log(probs[i] + 1e-9);
        probs[i] = (probs[i] - target) * scale; // gradient wrt logits
      }
      // backward
      for (let l = layers - 1; l >= 0; l--) {
        const w = model.W[l], inputs = model.sizes[l], outputs = model.sizes[l + 1], delta = this.deltas[l + 1], input = this.acts[l], gw = this.gW[l], gb = this.gb[l];
        const previous = l > 0 ? this.deltas[l] : null;
        if (previous) previous.fill(0);
        for (let o = 0; o < outputs; o++) {
          const d = delta[o]; if (d === 0) continue;
          gb[o] += d; const row = o * inputs;
          for (let i = 0; i < inputs; i++) gw[row + i] += d * input[i];
          if (previous) for (let i = 0; i < inputs; i++) previous[i] += w[row + i] * d;
        }
        if (previous) { const mask = this.masks[l], keepScale = this.dropout === 0 ? 1 : 1 / keep; for (let i = 0; i < inputs; i++) previous[i] = mask[i] ? previous[i] * keepScale : 0; }
      }
    }
    // Adam
    this.steps++;
    const beta1 = 0.9, beta2 = 0.999, correction1 = 1 - Math.pow(beta1, this.steps), correction2 = 1 - Math.pow(beta2, this.steps);
    const update = (param, grad, m, v, decay) => {
      for (let i = 0; i < param.length; i++) {
        const g = grad[i] + (decay ? this.l2 * param[i] : 0);
        m[i] = beta1 * m[i] + (1 - beta1) * g; v[i] = beta2 * v[i] + (1 - beta2) * g * g;
        param[i] -= this.learningRate * (m[i] / correction1) / (Math.sqrt(v[i] / correction2) + 1e-8);
      }
    };
    for (let l = 0; l < layers; l++) { update(model.W[l], this.gW[l], this.mW[l], this.vW[l], true); update(model.b[l], this.gb[l], this.mb[l], this.vb[l], false); }
    return loss;
  }
}
module.exports = { Mlp, Trainer, createRandom };
