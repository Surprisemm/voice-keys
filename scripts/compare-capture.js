'use strict';
// Compares how late the same microphone audio reaches the page through Chromium and through the native WASAPI helper.
// Run: compare-capture.bat [seconds] [microphone label]
//
// Both paths record the same device at the same time. Every block is stamped when the page receives it, on one clock.
// The two recordings are lined up by cross-correlating their waveforms (the microphone's own noise is enough, speaking is not needed),
// so each sample of the Chromium recording is matched with the same physical sample of the WASAPI recording.
// The reported number is how much later that sample reached the page through Chromium than through WASAPI.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createWasapiCapture } = require('../src/wasapi-capture');

const seconds = Math.max(6, Number(process.argv.find((arg, i) => i > 1 && /^\d+$/.test(arg))) || 12);
const label = process.argv.slice(2).find(arg => !/^\d+$/.test(arg) && !arg.startsWith('-')) || '';
const root = path.resolve(__dirname, '..');
const html = `<!doctype html><meta charset="utf-8"><body><script>
const { ipcRenderer } = require('electron');
const now = () => performance.timeOrigin + performance.now();
const rec = { chromium: { rate: 0, blocks: [] }, wasapi: { rate: 0, blocks: [] } };
ipcRenderer.on('wasapi', (_event, samples, rate) => { rec.wasapi.rate = rate; rec.wasapi.blocks.push({ t: now(), samples }); });
window.dump = () => rec;
(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  const audio = new AudioContext({ latencyHint: 'interactive' }); await audio.resume();
  await audio.audioWorklet.addModule('/capture-worklet.js');
  const node = new AudioWorkletNode(audio, 'capture-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  rec.chromium.rate = audio.sampleRate;
  node.port.onmessage = event => rec.chromium.blocks.push({ t: now(), samples: event.data });
  audio.createMediaStreamSource(stream).connect(node); node.connect(audio.destination);
  ipcRenderer.send('chromium-ready', stream.getAudioTracks()[0].label);
})().catch(error => ipcRenderer.send('chromium-failed', String(error)));
</script>`;

function joined(recording) {
  const total = recording.blocks.reduce((sum, block) => sum + block.samples.length, 0), samples = new Float32Array(total), ends = [];
  let at = 0;
  for (const block of recording.blocks) { samples.set(block.samples, at); at += block.samples.length; ends.push({ end: at, t: block.t }); }
  return { samples, ends, rate: recording.rate };
}
function resample(samples, from, to) {
  if (from === to) return samples;
  const out = new Float32Array(Math.floor(samples.length * to / from));
  for (let i = 0; i < out.length; i++) { const x = i * from / to, i0 = Math.floor(x), f = x - i0; out[i] = samples[i0] * (1 - f) + (samples[Math.min(i0 + 1, samples.length - 1)]) * f; }
  return out;
}
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = 2 * Math.PI / len * (inverse ? -1 : 1), wr = Math.cos(angle), wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
// Lag (in samples) such that x[i] ~ y[i - lag], searched within +-maxLag, with the peak's height relative to the typical correlation level.
function bestLag(x, y, maxLag) {
  let size = 1; while (size < x.length + y.length) size <<= 1;
  const ar = new Float64Array(size), ai = new Float64Array(size), br = new Float64Array(size), bi = new Float64Array(size);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length, mx = mean(x), my = mean(y);
  for (let i = 0; i < x.length; i++) ar[i] = x[i] - mx;
  for (let i = 0; i < y.length; i++) br[i] = y[i] - my;
  fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < size; i++) { const r = ar[i] * br[i] + ai[i] * bi[i], m = ai[i] * br[i] - ar[i] * bi[i]; ar[i] = r; ai[i] = m; }
  fft(ar, ai, true);
  let best = 0, bestValue = -Infinity, sumAbs = 0, count = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) { const v = ar[(lag + size) % size]; sumAbs += Math.abs(v); count++; if (v > bestValue) { bestValue = v; best = lag; } }
  return { lag: best, sharpness: bestValue / (sumAbs / count) };
}
const median = list => { const a = [...list].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
    else if (req.url === '/capture-worklet.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(root, 'ui', 'capture-worklet.js'))); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'media');
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  const chromiumReady = new Promise((resolve, reject) => { ipcMain.once('chromium-ready', (_e, name) => resolve(name)); ipcMain.once('chromium-failed', (_e, error) => reject(new Error(error))); });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`);

  const exe = app.isPackaged ? path.join(process.resourcesPath, 'native', 'WasapiCapture.exe') : path.join(root, 'native', 'WasapiCapture.exe');
  let header;
  // Same hop as in the app: helper -> main process -> page.
  const native = createWasapiCapture({ exe, onAudio: samples => { if (header) win.webContents.send('wasapi', samples, header.rate); } });
  let chromiumName;
  try { header = await native.start(label); chromiumName = await chromiumReady; }
  catch (error) { console.error(`Не удалось открыть микрофон: ${error.message}`); native.stop(); app.exit(1); return; }
  console.log(`Chromium: ${chromiumName}`);
  console.log(`WASAPI:   ${header.device} · ${header.api} · ${header.rate} Гц · период ${header.periodMs} мс`);
  console.log(`\nЗаписываю ${seconds} секунд одновременно двумя способами…`);
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  native.stop();
  const data = await win.webContents.executeJavaScript('window.dump()');
  const c = joined(data.chromium), w = joined(data.wasapi);
  if (!c.samples.length || !w.samples.length) { console.error('Один из потоков не дал звука.'); app.exit(1); return; }

  // Work at the Chromium rate; take the middle part so start-up effects do not matter.
  const rate = c.rate, wr = resample(w.samples, w.rate, rate), skip = Math.round(rate * 1.5), span = Math.min(Math.round(rate * 6), c.samples.length - skip - rate, wr.length - skip - rate);
  if (span < rate * 2) { console.error('Записи слишком короткие. Увеличьте время.'); app.exit(1); return; }
  const maxLag = Math.round(rate * 0.4);
  const cut = c.samples.subarray(skip, skip + span);
  const { lag, sharpness } = bestLag(wr.subarray(skip, skip + span + maxLag), cut, maxLag);
  // wr[i] ~ cut[i - lag]  =>  Chromium sample j matches WASAPI sample j + skip... computed below through the shared index.
  const wasapiIndexOf = j => (j + lag) * w.rate / rate;
  const at = (ends, index) => { let lo = 0, hi = ends.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (ends[mid].end > index) hi = mid; else lo = mid + 1; } return ends[lo].t; };
  const deltas = [];
  for (let j = skip; j < skip + span; j += 8) {
    const i = wasapiIndexOf(j);
    if (i < 0 || i >= w.samples.length) continue;
    deltas.push(at(c.ends, j) - at(w.ends, Math.floor(i)));
  }
  const mean = deltas.reduce((s, v) => s + v, 0) / deltas.length;
  const reliable = sharpness > 8;
  console.log(`\nСовпадение записей: пик корреляции в ${sharpness.toFixed(1)} раз выше фона ${reliable ? '(надёжно)' : '(ненадёжно: микрофон почти молчит, говорите или шумите во время записи)'}`);
  console.log(`Смещение записей: ${(lag / rate * 1000).toFixed(2)} мс`);
  console.log(`\nChromium доставляет звук на странице позже WASAPI: в среднем на ${mean.toFixed(1)} мс, медиана ${median(deltas).toFixed(1)} мс`);
  console.log(`(блок Chromium ${(1000 * c.ends[0].end / rate).toFixed(1)} мс, блок WASAPI ${(1000 * w.ends[0].end / w.rate).toFixed(1)} мс; сравнено ${deltas.length} точек)`);
  const out = path.join(root, 'data', 'capture-compare.json');
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), header, chromium: chromiumName, seconds, sharpness, reliable, lagMs: lag / rate * 1000, meanMs: mean, medianMs: median(deltas) }, null, 2)); console.log(`Результат записан: ${out}`); } catch { /* read-only folder */ }
  server.close(); app.quit();
});
