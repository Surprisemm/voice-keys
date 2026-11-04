'use strict';
// Copies the user's data from another Voice Keys data folder (the source folder's `data`, an old portable `VoiceKeys-data`, a backup).
// Settings, profiles, voice recordings and the classifier (recordings and model) come along. Logs, browser caches, downloaded models
// and the Python environment (several GB, tied to its folder) stay where they are.
const fs = require('node:fs');
const path = require('node:path');

const ITEMS = ['settings.json', 'classifier', 'samples'];

function inspect(source) {
  const found = ITEMS.filter(name => fs.existsSync(path.join(source, name)));
  return { found, hasSettings: found.includes('settings.json'), hasClassifier: found.includes('classifier'), hasPython: fs.existsSync(path.join(source, 'ml', 'venv')) };
}
function sameFolder(a, b) {
  const clean = value => path.resolve(value).toLowerCase().replace(/[\\/]+$/, '');
  return clean(a) === clean(b);
}
// Existing files with the same name are replaced; the replaced settings.json is kept as settings.json.before-import.json.
function importData(source, target) {
  if (!source || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('Выберите папку с данными Voice Keys.');
  if (sameFolder(source, target)) throw new Error('Это та же папка, из которой программа и так берёт данные.');
  const info = inspect(source);
  if (!info.found.length) throw new Error('В этой папке нет данных Voice Keys (нужен settings.json, classifier или samples).');
  fs.mkdirSync(target, { recursive: true });
  const config = path.join(target, 'settings.json');
  if (info.hasSettings && fs.existsSync(config)) fs.copyFileSync(config, `${config}.before-import.json`);
  for (const name of info.found) fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true, force: true });
  return { copied: info.found, hasPython: info.hasPython };
}
module.exports = { importData, inspect, ITEMS };
