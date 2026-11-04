'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createFrameParser, createWasapiCapture } = require('../src/wasapi-capture');
const { DEFAULTS, validateConfig } = require('../src/core');
const { validateStore } = require('../src/profiles');

const floats = values => Buffer.from(new Float32Array(values).buffer);

test('frame parser: header line, then samples, whatever the chunk boundaries', () => {
  const headers = [], blocks = [];
  const push = createFrameParser({ onHeader: header => headers.push(header), onSamples: samples => blocks.push(...samples) });
  const stream = Buffer.concat([Buffer.from('{"rate":48000,"device":"Микрофон"}\n', 'utf8'), floats([0.5, -0.25, 1, 0, 0.125])]);
  for (let at = 0; at < stream.length; at += 7) push(stream.subarray(at, at + 7));
  assert.deepEqual(headers, [{ rate: 48000, device: 'Микрофон' }]);
  assert.deepEqual(blocks, [0.5, -0.25, 1, 0, 0.125]);
});

test('frame parser: a sample split across two chunks is not lost or shifted', () => {
  const blocks = [];
  const push = createFrameParser({ onHeader: () => {}, onSamples: samples => blocks.push(...samples) });
  const data = floats([0.1, 0.2, 0.3]);
  push(Buffer.concat([Buffer.from('{}\n'), data.subarray(0, 6)]));
  push(data.subarray(6));
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map(value => Math.round(value * 10)), [1, 2, 3]);
});

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { child.killed = true; };
  return child;
}

test('capture: resolves with the header, forwards samples, reports a helper that dies', async () => {
  const child = fakeProcess(), got = [], ended = [];
  const capture = createWasapiCapture({ exe: 'x', spawnProcess: () => child, onAudio: samples => got.push(samples.length), onEnded: reason => ended.push(reason) });
  const started = capture.start('Микрофон (USB)');
  child.stdout.write('{"rate":44100,"api":"IAudioClient3","periodMs":10,"device":"USB","matched":true}\n');
  const header = await started;
  assert.equal(header.rate, 44100); assert.equal(capture.running(), true);
  child.stdout.write(floats([0, 0, 0, 0]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(got, [4]);
  child.stderr.write('ERROR: device invalidated\n');
  child.emit('exit', 3);
  assert.deepEqual(ended, ['device invalidated']);
  assert.equal(capture.running(), false);
});

test('capture: a helper that exits before the header rejects with its message', async () => {
  const child = fakeProcess();
  const capture = createWasapiCapture({ exe: 'x', spawnProcess: () => child, onAudio: () => {} });
  const started = capture.start('');
  child.stderr.write('ERROR: GetDefaultAudioEndpoint (0x80070490)\n');
  child.emit('exit', 2);
  await assert.rejects(started, /Нативный захват не запустился: GetDefaultAudioEndpoint/);
});

test('capture: stop closes the helper without reporting an error', async () => {
  const child = fakeProcess(), ended = [];
  const capture = createWasapiCapture({ exe: 'x', spawnProcess: () => child, onAudio: () => {}, onEnded: reason => ended.push(reason) });
  const started = capture.start('');
  child.stdout.write('{"rate":48000}\n'); await started;
  capture.stop();
  assert.equal(child.stdin.writableEnded, true);
  child.emit('exit', 0);
  assert.deepEqual(ended, []);
  assert.equal(capture.running(), false);
});

test('capture: a missing helper file gives an actionable message', async () => {
  const capture = createWasapiCapture({ exe: path.join(__dirname, 'no-such-helper.exe'), onAudio: () => {} });
  await assert.rejects(capture.start(''), /npm run native/);
});

test('config: capture mode is an app-wide setting, chromium unless wasapi is chosen', () => {
  assert.equal(DEFAULTS.captureMode, 'chromium');
  const base = { ...DEFAULTS, mappings: DEFAULTS.mappings };
  assert.equal(validateConfig(base).captureMode, 'chromium');
  assert.equal(validateConfig({ ...base, captureMode: 'wasapi' }).captureMode, 'wasapi');
  assert.equal(validateConfig({ ...base, captureMode: 'asio' }).captureMode, 'chromium');
  const { captureMode, ...legacy } = base;
  assert.equal(validateConfig(legacy).captureMode, 'chromium');
  const store = validateStore({ ...base, captureMode: 'wasapi' });
  assert.equal(store.captureMode, 'wasapi');
  assert.deepEqual(Object.keys(store.profiles[0].settings), ['mappings', 'neuralWords']);
});

const exe = path.join(__dirname, '..', 'native', 'WasapiCapture.exe');
const hasDevice = process.platform === 'win32' && fs.existsSync(exe) && (() => { try { return execFileSync(exe, ['--list'], { encoding: 'utf8', timeout: 10000 }).trim().length > 0; } catch { return false; } })();

test('real helper: opens the default microphone, streams mono float32 at its mix rate', { skip: !hasDevice && 'no Windows capture device or helper not built' }, async () => {
  const capture = createWasapiCapture({ exe, onAudio: samples => { total += samples.length; if (samples.some(value => !Number.isFinite(value) || Math.abs(value) > 1.0001)) bad++; } });
  let total = 0, bad = 0;
  const header = await capture.start('');
  assert.ok(header.rate >= 8000 && header.rate <= 192000, `rate ${header.rate}`);
  assert.ok(['IAudioClient3', 'IAudioClient'].includes(header.api));
  assert.ok(header.periodMs > 0 && header.periodMs <= 20, `period ${header.periodMs}`);
  assert.ok(header.device.length > 0);
  await new Promise(resolve => setTimeout(resolve, 1200));
  capture.stop();
  const expected = header.rate * 1.2;
  assert.ok(total > expected * 0.7 && total < expected * 1.3, `got ${total} samples, expected about ${Math.round(expected)}`);
  assert.equal(bad, 0);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(capture.running(), false);
});

test('real helper: an unknown device label falls back to the default microphone', { skip: !hasDevice && 'no Windows capture device or helper not built' }, async () => {
  const capture = createWasapiCapture({ exe, onAudio: () => {} });
  const header = await capture.start('Default - Несуществующий микрофон (ffff:ffff)');
  assert.equal(header.matched, false);
  assert.ok(header.device.length > 0);
  capture.stop();
});

test('real helper: Chromium-style labels (default prefix with a dash, vendor id suffix) select the same device', { skip: !hasDevice && 'no Windows capture device or helper not built' }, async () => {
  const first = createWasapiCapture({ exe, onAudio: () => {} });
  const { device } = await first.start('');
  first.stop();
  await new Promise(resolve => setTimeout(resolve, 600));
  for (const label of [`По умолчанию — ${device} (0a0a:0b0b)`, `Default - ${device}`, `Communications - ${device}`, device]) {
    const capture = createWasapiCapture({ exe, onAudio: () => {} });
    const header = await capture.start(label);
    capture.stop();
    assert.equal(header.matched, true, label);
    assert.equal(header.device, device, label);
    await new Promise(resolve => setTimeout(resolve, 400));
  }
});
