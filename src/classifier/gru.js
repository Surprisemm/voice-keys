'use strict';
// Runs a GRU classifier trained with PyTorch (tools/ml/train_classifier.py), one frame at a time with the state carried along.
// Equations are PyTorch's nn.GRU: r = s(Wir x + bir + Whr h + bhr), z = s(Wiz x + biz + Whz h + bhz),
// n = tanh(Win x + bin + r * (Whn h + bhn)), h' = (1 - z) * n + z * h; gate order in the weight matrices is r, z, n.

function decode(text) {
  const bytes = Buffer.from(text, 'base64'), array = new Float32Array(bytes.length / 4);
  for (let i = 0; i < array.length; i++) array[i] = bytes.readFloatLE(i * 4);
  return array;
}
const sigmoid = x => 1 / (1 + Math.exp(-x));

class GruNet {
  constructor(net, mels, hidden) {
    this.mels = mels; this.hidden = hidden;
    this.inW = decode(net.inW); this.inB = decode(net.inB); this.outW = decode(net.outW); this.outB = decode(net.outB);
    this.layers = net.gru.map(layer => ({ wih: decode(layer.wih), whh: decode(layer.whh), bih: decode(layer.bih), bhh: decode(layer.bhh) }));
    this.classes = this.outB.length;
    if (this.inW.length !== hidden * mels || this.outW.length !== this.classes * hidden) throw new Error('Файл классификатора повреждён: размеры весов не совпадают.');
    this.state = this.layers.map(() => new Float32Array(hidden));
    this.u = new Float32Array(hidden); this.gi = new Float32Array(3 * hidden); this.gh = new Float32Array(3 * hidden); this.next = new Float32Array(hidden);
    this.logits = new Float32Array(this.classes);
  }
  reset() { for (const h of this.state) h.fill(0); }
  // One normalised log-mel frame -> class probabilities (the returned array is reused).
  step(frame) {
    const H = this.hidden, u = this.u;
    for (let o = 0; o < H; o++) { let acc = this.inB[o]; const row = o * this.mels; for (let i = 0; i < this.mels; i++) acc += this.inW[row + i] * frame[i]; u[o] = acc > 0 ? acc : 0; }
    for (let l = 0; l < this.layers.length; l++) {
      const { wih, whh, bih, bhh } = this.layers[l], h = this.state[l], gi = this.gi, gh = this.gh, next = this.next;
      for (let o = 0; o < 3 * H; o++) {
        let a = bih[o], b = bhh[o]; const row = o * H;
        for (let i = 0; i < H; i++) { a += wih[row + i] * u[i]; b += whh[row + i] * h[i]; }
        gi[o] = a; gh[o] = b;
      }
      for (let i = 0; i < H; i++) {
        const r = sigmoid(gi[i] + gh[i]), z = sigmoid(gi[H + i] + gh[H + i]), n = Math.tanh(gi[2 * H + i] + r * gh[2 * H + i]);
        next[i] = (1 - z) * n + z * h[i];
      }
      h.set(next); u.set(next);
    }
    const logits = this.logits; let max = -Infinity;
    for (let c = 0; c < this.classes; c++) { let acc = this.outB[c]; const row = c * H; for (let i = 0; i < H; i++) acc += this.outW[row + i] * u[i]; logits[c] = acc; if (acc > max) max = acc; }
    let sum = 0; for (let c = 0; c < this.classes; c++) { logits[c] = Math.exp(logits[c] - max); sum += logits[c]; }
    for (let c = 0; c < this.classes; c++) logits[c] /= sum;
    return logits;
  }
}
module.exports = { GruNet };
