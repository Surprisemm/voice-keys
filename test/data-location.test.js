'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDataDir, legacyToImport } = require('../src/data-location');
const { importData, inspect } = require('../src/data-import');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vk-data-'));
const base = { appData: 'C:/Users/x/AppData/Roaming', execPath: 'C:/Apps/Voice Keys/Voice Keys.exe', root: 'E:/project' };

test('data folder: env first, then source tree, portable next to the exe, installed in AppData', () => {
  assert.deepEqual(resolveDataDir({ ...base, env: { VOICE_KEYS_DATA_DIR: 'D:/d', PORTABLE_EXECUTABLE_DIR: 'F:/p' }, isPackaged: true }), { dir: 'D:/d', mode: 'env' });
  assert.deepEqual(resolveDataDir({ ...base, env: {}, isPackaged: false }), { dir: path.join('E:/project', 'data'), mode: 'dev' });
  assert.deepEqual(resolveDataDir({ ...base, env: { PORTABLE_EXECUTABLE_DIR: 'F:/p' }, isPackaged: true }), { dir: path.join('F:/p', 'VoiceKeys-data'), mode: 'portable' });
  const installed = resolveDataDir({ ...base, env: {}, isPackaged: true });
  assert.equal(installed.mode, 'installed'); assert.equal(installed.dir, path.join('C:/Users/x/AppData/Roaming', 'Voice Keys'));
});

test('an installed copy picks up VoiceKeys-data left next to the exe by an older build, once', () => {
  const dir = temp();
  try {
    const exeDir = path.join(dir, 'app'), data = path.join(dir, 'appdata', 'Voice Keys');
    fs.mkdirSync(path.join(exeDir, 'VoiceKeys-data'), { recursive: true }); fs.mkdirSync(data, { recursive: true });
    const location = { mode: 'installed', dir: data, legacy: path.join(exeDir, 'VoiceKeys-data') };
    assert.equal(legacyToImport(location), null, 'nothing to carry over without settings');
    fs.writeFileSync(path.join(exeDir, 'VoiceKeys-data', 'settings.json'), '{}');
    assert.equal(legacyToImport(location), location.legacy);
    fs.writeFileSync(path.join(data, 'settings.json'), '{}');
    assert.equal(legacyToImport(location), null, 'an existing configuration is never overwritten automatically');
    assert.equal(legacyToImport({ ...location, mode: 'portable' }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import: copies settings, classifier and samples, keeps the old settings, skips caches, logs and Python', () => {
  const dir = temp(), from = path.join(dir, 'from'), to = path.join(dir, 'to');
  try {
    fs.mkdirSync(path.join(from, 'classifier', 'words', 'удар'), { recursive: true }); fs.mkdirSync(path.join(from, 'samples'), { recursive: true });
    fs.mkdirSync(path.join(from, 'logs'), { recursive: true }); fs.mkdirSync(path.join(from, 'electron'), { recursive: true }); fs.mkdirSync(path.join(from, 'ml', 'venv'), { recursive: true });
    fs.writeFileSync(path.join(from, 'settings.json'), '{"new":true}'); fs.writeFileSync(path.join(from, 'classifier', 'model.json'), '{}'); fs.writeFileSync(path.join(from, 'classifier', 'words', 'удар', 'a.wav'), 'x');
    fs.writeFileSync(path.join(from, 'logs', 'l.jsonl'), 'x');
    fs.mkdirSync(to, { recursive: true }); fs.writeFileSync(path.join(to, 'settings.json'), '{"old":true}');
    const info = inspect(from); assert.deepEqual(info.found.sort(), ['classifier', 'samples', 'settings.json']); assert.equal(info.hasPython, true);
    const result = importData(from, to);
    assert.equal(fs.readFileSync(path.join(to, 'settings.json'), 'utf8'), '{"new":true}');
    assert.equal(fs.readFileSync(path.join(to, 'settings.json.before-import.json'), 'utf8'), '{"old":true}');
    assert.ok(fs.existsSync(path.join(to, 'classifier', 'words', 'удар', 'a.wav')) && fs.existsSync(path.join(to, 'samples')));
    for (const skipped of ['logs', 'electron', 'ml']) assert.equal(fs.existsSync(path.join(to, skipped)), false, skipped);
    assert.equal(result.hasPython, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import: refuses the same folder, a missing folder and a folder without Voice Keys data', () => {
  const dir = temp();
  try {
    fs.mkdirSync(path.join(dir, 'a')); fs.writeFileSync(path.join(dir, 'a', 'readme.txt'), 'x');
    assert.throws(() => importData(path.join(dir, 'nope'), dir), /Выберите папку/);
    assert.throws(() => importData(path.join(dir, 'a'), path.join(dir, 'a')), /та же папка/);
    assert.throws(() => importData(path.join(dir, 'a'), path.join(dir, 'b')), /нет данных Voice Keys/);
    assert.equal(fs.existsSync(path.join(dir, 'b')), false, 'nothing is created for a refused import');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
