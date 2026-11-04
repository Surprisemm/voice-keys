'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Local JSON Lines only. Never stores audio or sends anything over the network.
function createLogger(directory, { maxBytes = 5 * 1024 * 1024 } = {}) {
  const sessionId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  let part = 1, bytes = 0, failure = '';
  const file = () => path.join(directory, `voice-keys-${sessionId}-${part}.jsonl`);
  try { fs.mkdirSync(directory, { recursive: true }); }
  catch (error) { failure = error.message; }
  function write(event, details = {}, level = 'info') {
    const record = { time: new Date().toISOString(), session: sessionId, level, event, ...details };
    try {
      const line = JSON.stringify(record) + '\n';
      const size = Buffer.byteLength(line);
      if (bytes && bytes + size > maxBytes) { part++; bytes = 0; }
      fs.appendFileSync(file(), line, 'utf8');
      bytes += size;
    } catch (error) { failure = error.message; console.error('Ошибка записи журнала:', error.message); }
  }
  return { write, info: () => ({ directory, file: file(), sessionId, error: failure }) };
}
module.exports = { createLogger };
