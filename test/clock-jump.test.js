'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { monotonicNow } = require('../src/core');
const { createKeyController } = require('../src/key-controller');
const { createArbiter } = require('../src/classifier/arbiter');

// Seen in the logs of an installed copy: the system clock stepped back by an hour while the queue held a released key,
// and every following command waited for that hour. The default clock must not follow such changes.
function stepClockBack(t, ms) {
  const real = Date.now;
  t.mock.method(Date, 'now', () => real() - ms);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a system clock step back does not delay the next press of the same key', async t => {
  const events = [];
  const input = createKeyController({ down: key => (events.push(['down', key]), true), up: key => (events.push(['up', key]), true), isDown: () => false, modifiersDown: () => false }, { releaseGapMs: 30 });
  assert.equal((await input.perform({ key: 'Q', durationMs: 20 })).ok, true);
  stepClockBack(t, 3600 * 1000);
  const second = await Promise.race([input.perform({ key: 'Q', durationMs: 20 }), pause(1000).then(() => 'stuck')]);
  assert.notEqual(second, 'stuck');
  assert.equal(second.ok, true);
  assert.equal(events.filter(event => event[0] === 'down').length, 2);
});
test('the monotonic clock ignores a system clock step', t => {
  const before = monotonicNow();
  stepClockBack(t, 3600 * 1000);
  assert.ok(monotonicNow() - before >= 0 && monotonicNow() - before < 1000);
});
test('the dedupe window still expires after a system clock step back', async t => {
  const arbiter = createArbiter({ windowMs: 60 });
  assert.equal(arbiter.claim('classifier', 'Q||tap'), true);
  stepClockBack(t, 3600 * 1000);
  await pause(120);
  assert.equal(arbiter.claim('text', 'Q||tap'), true);
});
