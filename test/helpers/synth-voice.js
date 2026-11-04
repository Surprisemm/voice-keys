'use strict';
// Synthetic "spoken words" for tests: harmonic sources shaped by two moving formants. Different words have different formant tracks.
const { createRandom } = require('../../src/classifier/model');
const RATE = 16000;
const WORDS = {
  alfa: [[700, 1200], [300, 2300], [500, 1500]],
  bravo: [[300, 2300], [700, 1200], [350, 900]],
  charlie: [[450, 800], [450, 800], [250, 2200], [600, 1100]],
  delta: [[600, 1700], [300, 700], [700, 1100]]
};
function syllable(formants, f0, ms, rate = RATE) {
  const n = Math.round(rate * ms / 1000), out = new Float32Array(n), [f1, f2] = formants;
  for (let h = 1; h * f0 < 5000; h++) {
    const freq = h * f0, a = Math.exp(-(((freq - f1) / 160) ** 2)) + 0.6 * Math.exp(-(((freq - f2) / 260) ** 2)) + 0.02;
    for (let i = 0; i < n; i++) out[i] += a * Math.sin(2 * Math.PI * freq * i / rate);
  }
  for (let i = 0; i < n; i++) out[i] *= 0.5 - 0.5 * Math.cos(2 * Math.PI * Math.min(i, n - 1 - i) / Math.max(1, n - 1) * 1.0) ;
  return out;
}
function word(name, random, tracks = WORDS[name]) {
  const f0 = 110 + 40 * random.uniform(), speed = 0.9 + 0.2 * random.uniform(), parts = [];
  for (const [f1, f2] of tracks) parts.push(syllable([f1 * (0.94 + 0.12 * random.uniform()), f2 * (0.94 + 0.12 * random.uniform())], f0 * (0.95 + 0.1 * random.uniform()), 120 * speed * (0.85 + 0.3 * random.uniform())));
  const total = parts.reduce((s, p) => s + p.length, 0), out = new Float32Array(total); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < out.length; i++) out[i] = out[i] / peak * 0.25;
  return out;
}
// a recording like the app makes: a little silence, the word, silence
function take(name, random, tracks) {
  const body = word(name, random, tracks), lead = Math.round(RATE * (0.3 + 0.3 * random.uniform())), tail = Math.round(RATE * 0.4), out = new Float32Array(lead + body.length + tail);
  out.set(body, lead);
  for (let i = 0; i < out.length; i++) out[i] += random.normal() * 0.0008;
  return out;
}
function randomTracks(random) { return Array.from({ length: 2 + random.int(3) }, () => [250 + 500 * random.uniform(), 700 + 1700 * random.uniform()]); }
// background: noise, tone bursts and made-up words
function background(seconds, random) {
  const out = new Float32Array(Math.round(RATE * seconds)); let at = 0;
  while (at < out.length) {
    const kind = random.int(3), segment = kind === 0 ? new Float32Array(Math.round(RATE * (0.3 + random.uniform()))) : kind === 1 ? syllable([300 + 600 * random.uniform(), 900 + 1500 * random.uniform()], 90 + 120 * random.uniform(), 150 + 200 * random.uniform()) : word('alfa', random, randomTracks(random));
    for (let i = 0; i < segment.length && at + i < out.length; i++) out[at + i] += segment[i] * (kind === 0 ? 0 : 0.8);
    at += segment.length + Math.round(RATE * (0.2 + 0.8 * random.uniform()));
  }
  for (let i = 0; i < out.length; i++) out[i] += random.normal() * 0.001;
  return out;
}
module.exports = { RATE, WORDS, take, background, randomTracks, createRandom };
