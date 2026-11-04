'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CATALOG, MODELS, VOSK, catalogId, voskArchive } = require('../src/models');

test('every model has a licence, a source and a size to show before the download', () => {
  assert.deepEqual(Object.keys(CATALOG).sort(), ['gigaam', 'sherpa', 'vosk-en', 'vosk-ru']);
  for (const entry of Object.values(CATALOG)) for (const field of ['title', 'license', 'author', 'source']) assert.ok(entry[field], field);
  for (const entry of Object.values(CATALOG)) assert.ok(entry.sizeMb > 0);
  for (const id of Object.keys(MODELS)) assert.ok(CATALOG[id], `${id} is in the catalog`);
});
test('the Vosk choice depends on the language', () => {
  assert.equal(catalogId('vosk', 'en'), 'vosk-en'); assert.equal(catalogId('vosk', 'ru'), 'vosk-ru'); assert.equal(catalogId('gigaam', 'ru'), 'gigaam');
});
test('a Vosk archive counts as downloaded only when it is really there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-vosk-'));
  try {
    assert.equal(voskArchive(dir, 'ru'), null);
    fs.writeFileSync(path.join(dir, VOSK.ru.file), Buffer.alloc(10)); assert.equal(voskArchive(dir, 'ru'), null, 'a stub is not a model');
    fs.writeFileSync(path.join(dir, VOSK.ru.file), Buffer.alloc(1500000)); assert.equal(voskArchive([path.join(dir, 'none'), dir], 'ru'), path.join(dir, VOSK.ru.file));
    assert.equal(voskArchive(dir, 'en'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
