'use strict';
// Writes test/fixtures/classifier-parity.json: what the JavaScript signal chain produces for a fixed test signal, so the
// Python training code (tools/ml/features.py) can be checked against it. Re-run after changing src/classifier/dsp.js.
const fs = require('node:fs');
const path = require('node:path');
const { Resampler, logMel } = require('../src/classifier/dsp');

function testSignal(rate, seconds) {
  const n = Math.round(rate * seconds), x = new Float32Array(n); let state = 12345;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    x[i] = 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.2 * Math.sin(2 * Math.PI * 2300 * t + 1) + 0.15 * Math.sin(2 * Math.PI * (300 + 2000 * t) * t) + 0.05 * (state / 4294967296 - 0.5);
  }
  return x;
}
const out = {};
for (const rate of [44100, 48000]) {
  const x = testSignal(rate, 0.6), r = new Resampler(rate, 16000), y = r.push(x);
  out[rate] = { samples: x.length, resampled: Array.from(y, v => Math.round(v * 1e6) / 1e6) };
}
const y16 = Float32Array.from(out[48000].resampled);
out.logMel48000 = logMel(y16).map(frame => Array.from(frame, v => Math.round(v * 1e5) / 1e5));
const target = path.join(__dirname, '..', 'test', 'fixtures', 'classifier-parity.json');
fs.writeFileSync(target, JSON.stringify(out)); console.log(`${target} (${Math.round(fs.statSync(target).size / 1024)} KB)`);
