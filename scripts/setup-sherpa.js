'use strict';
// Usage: node scripts/setup-sherpa.js [sherpa|gigaam]. Downloads one model from the official k2-fsa/sherpa-onnx release.
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { MODELS, modelFilesReady } = require('../src/models');
// The app passes the writable models folder; run by hand, models go next to the sources.
const ROOT = process.env.VOICE_KEYS_MODELS_DIR || path.resolve(__dirname, '..', 'models');
const id = process.argv[2] || 'sherpa';
async function main() {
  const model = MODELS[id];
  if (!model) throw new Error(`Unknown model: ${id}`);
  const directory = path.join(ROOT, model.directory);
  if (modelFilesReady(ROOT, id)) return console.log(`${model.title} is ready.`);
  fs.mkdirSync(ROOT, { recursive: true });
  const archive = path.join(ROOT, model.directory + '.tar.bz2');
  if (!fs.existsSync(archive)) {
    console.log(`Downloading ${model.title} (about ${model.sizeMb} MB) from the official k2-fsa/sherpa-onnx release...`);
    const response = await fetch(`https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${model.directory}.tar.bz2`, { signal: AbortSignal.timeout(900000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive + '.part'));
    fs.renameSync(archive + '.part', archive);
  }
  const uncompressed = path.join(ROOT, model.directory + '.tar');
  console.log(`Extracting ${model.title}...`);
  await pipeline(fs.createReadStream(archive), require('unbzip2-stream')(), fs.createWriteStream(uncompressed));
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const entries = execFileSync(tar, ['-tf', uncompressed], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean);
  if (entries.some(entry => !entry.replace(/^\.\//, '').startsWith(model.directory + '/') || entry.split(/[\\/]/).includes('..'))) throw new Error('Unexpected archive paths.');
  execFileSync(tar, ['-xf', uncompressed], { cwd: ROOT });
  fs.unlinkSync(archive); fs.unlinkSync(uncompressed);
  if (!modelFilesReady(ROOT, id)) throw new Error('Model extraction failed.');
  console.log(`${model.title} is ready.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
