'use strict';
// Signal processing for the personal command classifier: WAV helpers, streaming resampler to 16 kHz, log-mel frames.
// No dependencies, so the same code runs in the app, in a worker thread and in the command-line tools.

const RATE = 16000, FRAME = 400, HOP = 160, NFFT = 512, MELS = 32, FMIN = 60, FMAX = 7600;

// ---------- WAV ----------
function readWav(buffer) {
  let at = 12, rate = 16000, channels = 1, bits = 16, data = null;
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('ascii', at, at + 4), size = buffer.readUInt32LE(at + 4);
    if (id === 'fmt ') { channels = buffer.readUInt16LE(at + 10); rate = buffer.readUInt32LE(at + 12); bits = buffer.readUInt16LE(at + 22); }
    if (id === 'data') { data = buffer.subarray(at + 8, Math.min(buffer.length, at + 8 + size)); break; }
    at += 8 + size + (size & 1);
  }
  if (!data || bits !== 16) throw new Error('Нужен WAV с 16-битным звуком.');
  const frames = Math.floor(data.length / 2 / channels), samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { let sum = 0; for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2); samples[i] = sum / channels / 32768; }
  return { rate, samples };
}
function writeWav(samples, rate = RATE) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + samples.length * 2, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return out;
}

// ---------- resampling ----------
// Streaming: low-pass FIR (windowed sinc) at the input rate, then linear interpolation to the output rate.
class Resampler {
  constructor(from, to = RATE) {
    this.from = from; this.to = to; this.step = from / to; this.passthrough = from === to;
    const taps = 63, cutoff = Math.min(0.46 * to, 0.46 * from) / from; // cycles per input sample
    this.taps = new Float64Array(taps); let sum = 0;
    for (let i = 0; i < taps; i++) {
      const n = i - (taps - 1) / 2, sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
      this.taps[i] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1))); sum += this.taps[i];
    }
    for (let i = 0; i < taps; i++) this.taps[i] /= sum;
    this.history = new Float32Array(taps - 1); this.position = 0; this.previous = 0;
  }
  push(input) {
    if (this.passthrough) return input;
    const taps = this.taps, count = taps.length, joined = new Float32Array(this.history.length + input.length);
    joined.set(this.history); joined.set(input, this.history.length);
    const n = input.length, filtered = new Float32Array(n);
    for (let i = 0; i < n; i++) { let acc = 0; for (let k = 0; k < count; k++) acc += taps[k] * joined[i + k]; filtered[i] = acc; }
    this.history = joined.slice(joined.length - (count - 1));
    // Output samples sit at fractional input positions; position -1 is the last sample of the previous chunk.
    const out = []; let p = this.position;
    while (Math.floor(p) + 2 <= n) {
      const i0 = Math.floor(p), fraction = p - i0, a = i0 < 0 ? this.previous : filtered[i0], b = filtered[i0 + 1];
      out.push(a * (1 - fraction) + b * fraction); p += this.step;
    }
    this.position = p - n; this.previous = filtered[n - 1];
    return Float32Array.from(out);
  }
}
function resample(samples, from, to = RATE) { return from === to ? samples : new Resampler(from, to).push(samples); }

// ---------- FFT and mel ----------
function makeFft(size) {
  const bits = Math.log2(size), reverse = new Uint32Array(size), cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
  for (let i = 0; i < size; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); reverse[i] = r; }
  for (let i = 0; i < size / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / size); sin[i] = -Math.sin(2 * Math.PI * i / size); }
  return function fft(re, im) {
    for (let i = 0; i < size; i++) { const j = reverse[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1, stride = size / len;
      for (let i = 0; i < size; i += len) for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half, wr = cos[k * stride], wi = sin[k * stride], tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  };
}
const hzToMel = hz => 2595 * Math.log10(1 + hz / 700), melToHz = mel => 700 * (Math.pow(10, mel / 2595) - 1);
function melBank() {
  const bins = NFFT / 2 + 1, points = Array.from({ length: MELS + 2 }, (_, i) => melToHz(hzToMel(FMIN) + (hzToMel(FMAX) - hzToMel(FMIN)) * i / (MELS + 1)));
  const filters = [];
  for (let m = 0; m < MELS; m++) {
    const lo = points[m], mid = points[m + 1], hi = points[m + 2], weights = [];
    let first = -1;
    for (let b = 0; b < bins; b++) {
      const hz = b * RATE / NFFT; let w = 0;
      if (hz > lo && hz < mid) w = (hz - lo) / (mid - lo); else if (hz >= mid && hz < hi) w = (hi - hz) / (hi - mid);
      if (w > 0) { if (first < 0) first = b; weights.push(w); }
    }
    filters.push({ first: Math.max(first, 0), weights: Float64Array.from(weights) });
  }
  return filters;
}
const WINDOW = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME - 1)));
const FFT = makeFft(NFFT), BANK = melBank();

// Streaming log-mel: push 16 kHz samples, get one Float32Array(MELS) per 10 ms hop.
class FeatureStream {
  constructor() { this.buffer = new Float32Array(0); this.re = new Float64Array(NFFT); this.im = new Float64Array(NFFT); }
  push(samples) {
    const joined = new Float32Array(this.buffer.length + samples.length); joined.set(this.buffer); joined.set(samples, this.buffer.length);
    const frames = []; let at = 0;
    while (at + FRAME <= joined.length) {
      const re = this.re, im = this.im;
      let previous = 0;
      for (let i = 0; i < FRAME; i++) { const value = joined[at + i]; re[i] = (value - 0.97 * previous) * WINDOW[i]; previous = value; im[i] = 0; }
      re.fill(0, FRAME); im.fill(0, FRAME);
      FFT(re, im);
      const frame = new Float32Array(MELS);
      for (let m = 0; m < MELS; m++) {
        const { first, weights } = BANK[m]; let energy = 0;
        for (let k = 0; k < weights.length; k++) { const b = first + k; energy += weights[k] * (re[b] * re[b] + im[b] * im[b]); }
        frame[m] = Math.log(energy + 1e-6);
      }
      frames.push(frame); at += HOP;
    }
    this.buffer = joined.slice(at);
    return frames;
  }
}
// All frames of a finished 16 kHz recording. Frame f covers samples [f*HOP, f*HOP + FRAME).
function logMel(samples) { return new FeatureStream().push(samples); }

// ---------- word segmentation ----------
// Finds the spoken part of a short recording by its energy: returns {start, end} in samples, or null if there is no clear speech.
function segmentWord(samples, rate = RATE) {
  const hop = Math.round(rate * 0.01), rms = [];
  for (let i = 0; i + hop <= samples.length; i += hop) { let s = 0; for (let j = 0; j < hop; j++) s += samples[i + j] * samples[i + j]; rms.push(Math.sqrt(s / hop)); }
  if (rms.length < 10) return null;
  const sorted = [...rms].sort((a, b) => a - b), floor = sorted[Math.floor(sorted.length * 0.2)], peak = sorted[sorted.length - 1];
  if (peak < 0.01 || peak < floor * 4) return null;
  const threshold = Math.max(floor * 3, peak * 0.1);
  let first = rms.findIndex(value => value > threshold), last = rms.length - 1;
  while (last > first && rms[last] <= threshold) last--;
  if (first < 0) return null;
  // merge: a short dip inside a word must not end it, so the word runs to the last loud frame of the main burst
  return { start: Math.max(0, first - 2) * hop, end: Math.min(samples.length, (last + 3) * hop) };
}

module.exports = { RATE, FRAME, HOP, NFFT, MELS, readWav, writeWav, Resampler, resample, FeatureStream, logMel, segmentWord };
