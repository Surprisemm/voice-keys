'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { microphoneOptions } = require('../src/microphones');
const { microphoneCheck } = require('../src/permissions');
const input = (id, label) => ({ kind: 'audioinput', deviceId: id, label });
test('microphone list shows Windows names and removes duplicate default aliases', () => {
  const list = microphoneOptions([input('default', 'Default - Analogue 1 + 2 (Focusrite USB Audio)'), input('communications', 'Communications - Analogue 1 + 2 (Focusrite USB Audio)'), input('physical', 'Analogue 1 + 2 (Focusrite USB Audio)'), { kind: 'audiooutput', deviceId: 'speaker', label: 'Speakers' }]);
  assert.equal(list.options.length, 2);
  assert.match(list.options[0].label, /Focusrite/);
  assert.equal(list.options[1].label, 'Analogue 1 + 2 (Focusrite USB Audio)');
});
test('saved microphone is restored by exact unique name after salted ID changes', () => {
  const list = microphoneOptions([input('new-id', 'My USB Mic')], 'old-id', 'My USB Mic');
  assert.equal(list.selectedId, 'new-id'); assert(!list.options.some(option => option.missing));
});
test('missing or ambiguous microphones never silently switch to a default device', () => {
  for (const devices of [[], [input('one', 'Same Mic'), input('two', 'Same Mic')]]) {
    const list = microphoneOptions(devices, 'previous-id', 'Same Mic');
    assert.equal(list.selectedId, 'previous-id'); assert.equal(list.options.at(-1).missing, true);
  }
});
test('an active stream provides a real label while enumeration labels are hidden', () => {
  const list = microphoneOptions([input('physical', '')], '', '', { id: 'physical', label: 'Focusrite USB Audio' });
  assert.equal(list.options[1].label, 'Focusrite USB Audio');
});
const check = overrides => microphoneCheck({ owner: true, permission: 'media', requestingOrigin: 'http://127.0.0.1:3055/', details: { mediaType: 'audio' }, origin: 'http://127.0.0.1:3055', ...overrides });
test('microphone permission accepts the own origin with or without a trailing slash', () => {
  assert.equal(check({}), true); assert.equal(check({ requestingOrigin: 'http://127.0.0.1:3055' }), true);
});
test('device enumeration media checks with unknown type retain microphone names', () => assert.equal(check({ details: { mediaType: 'unknown' } }), true));
test('camera, foreign contents and unrelated origins remain denied', () => {
  assert.equal(check({ details: { mediaType: 'video' } }), false);
  assert.equal(check({ owner: false }), false);
  assert.equal(check({ permission: 'geolocation' }), false);
  assert.equal(check({ requestingOrigin: 'https://example.com' }), false);
  assert.equal(check({ requestingOrigin: 'http://127.0.0.1:3056' }), false);
});
