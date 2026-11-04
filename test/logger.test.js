'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createLogger } = require('../src/logger');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-keys-test-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    const temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(temporaryRoot) || !path.basename(resolved).startsWith('voice-keys-test-')) throw new Error('Недопустимая папка очистки.');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}

test('journal preserves UTF-8 events, session and timestamps in parseable JSON lines', t => {
  const logger = createLogger(temporaryDirectory(t));
  logger.write('recognition.final', { text: 'первый', epoch: 1 });
  logger.write('input.result', { key: 'Q', ok: false, reason: 'Клавиша уже удерживается' }, 'warn');
  const lines = fs.readFileSync(logger.info().file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'первый');
  assert.equal(lines[0].session, lines[1].session);
  assert(Number.isFinite(Date.parse(lines[0].time)));
  assert.equal(lines[1].level, 'warn');
  assert.equal(lines[1].ok, false);
  assert.equal(logger.info().error, '');
});

test('journal rotation retains all events in separate files', t => {
  const directory = temporaryDirectory(t);
  const logger = createLogger(directory, { maxBytes: 250 });
  for (let number = 0; number < 5; number++) logger.write('action.preview', { actionId: number, phrase: 'первый', key: 'Q' });
  const files = fs.readdirSync(directory);
  assert(files.length > 1);
  const records = files.flatMap(file => fs.readFileSync(path.join(directory, file), 'utf8').trim().split('\n').map(JSON.parse));
  assert.deepEqual(records.map(record => record.actionId).sort(), [0, 1, 2, 3, 4]);
});
