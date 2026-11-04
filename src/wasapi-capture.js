'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');

// Splits the helper's stdout into the JSON header line and mono float32 sample blocks.
function createFrameParser({ onHeader, onSamples }) {
  let head = Buffer.alloc(0), headerDone = false, spare = Buffer.alloc(0);
  return function push(chunk) {
    if (!headerDone) {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(10);
      if (end < 0) return;
      headerDone = true;
      onHeader(JSON.parse(head.subarray(0, end).toString('utf8')));
      chunk = head.subarray(end + 1); head = null;
    }
    const joined = spare.length ? Buffer.concat([spare, chunk]) : chunk, usable = joined.length - (joined.length % 4);
    spare = Buffer.from(joined.subarray(usable));
    if (!usable) return;
    // Copy: the stream reuses its buffers and a Float32Array view must start on a 4-byte boundary.
    const samples = new Float32Array(usable / 4);
    Buffer.from(samples.buffer).set(joined.subarray(0, usable));
    onSamples(samples);
  };
}

// Runs WasapiCapture.exe. onAudio(Float32Array) gets mono samples at header.rate; onEnded(reason) fires when the helper exits on its own.
function createWasapiCapture({ exe, onAudio, onEnded = () => {}, spawnProcess = spawn }) {
  let child = null;
  async function start(deviceLabel = '') {
    if (child) throw new Error('Захват уже запущен.');
    if (spawnProcess === spawn && !fs.existsSync(exe)) throw new Error(`Нет файла ${exe}. Соберите его командой «npm run native».`);
    const args = deviceLabel ? ['--device', deviceLabel] : [];
    const process_ = spawnProcess(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = process_;
    let errorText = '';
    process_.stderr.on('data', data => { errorText += String(data); });
    return new Promise((resolve, reject) => {
      let started = false;
      const timer = setTimeout(() => { if (!started) { reject(new Error('Нативный захват не ответил за 5 секунд.')); stop(); } }, 5000);
      const push = createFrameParser({
        onHeader: header => { started = true; clearTimeout(timer); resolve(header); },
        onSamples: samples => { if (child === process_) onAudio(samples); }
      });
      process_.stdout.on('data', data => { try { push(data); } catch (error) { if (!started) reject(error); } });
      process_.once('error', error => { clearTimeout(timer); if (child === process_) child = null; if (!started) reject(error); else onEnded(error.message); });
      process_.once('exit', code => {
        clearTimeout(timer); if (child === process_) child = null;
        const reason = errorText.trim().replace(/^ERROR:\s*/, '') || `код ${code}`;
        if (!started) reject(new Error(`Нативный захват не запустился: ${reason}`));
        else if (!process_.stopRequested) onEnded(reason);
      });
    });
  }
  function stop() {
    const target = child; child = null;
    if (!target) return;
    target.stopRequested = true;
    try { target.stdin.end(); } catch { /* already closed */ }
    setTimeout(() => { try { target.kill(); } catch { /* already gone */ } }, 500).unref();
  }
  return { start, stop, running: () => child !== null };
}
module.exports = { createWasapiCapture, createFrameParser };
