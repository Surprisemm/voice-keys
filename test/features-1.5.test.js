'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS, validateConfig, WordCommandMatcher, actionLabel, MOUSE_KEYS } = require('../src/core');
const { createKeyController } = require('../src/key-controller');
const { validateStore, changeProfile, exportProfiles, importProfiles } = require('../src/profiles');
const { drawAppIcon, GREY } = require('../src/tray-icon');
const config = mappings => validateConfig({ ...DEFAULTS, mappings });

test('modifiers are validated, ordered and carried into actions and labels', () => {
  const valid = config([{ phrase: 'удар', key: 'Q', language: 'ru', modifiers: ['ALT', 'CTRL'] }]);
  assert.deepEqual(valid.mappings[0].modifiers, ['CTRL', 'ALT']);
  const action = new WordCommandMatcher(valid.mappings, 'ru', { wordStabilityMs: 0 }).assess('удар', true).actions[0];
  assert.deepEqual([action.modifiers, action.label], [['CTRL', 'ALT'], 'Ctrl+Alt+Q']);
  assert.throws(() => config([{ phrase: 'удар', key: 'Q', language: 'ru', modifiers: ['WIN'] }]), /Ctrl, Shift и Alt/);
  assert.deepEqual(config([{ phrase: 'удар', key: 'Q', language: 'ru' }]).mappings[0].modifiers, []);
  assert.equal(actionLabel('MOUSE_MIDDLE', ['SHIFT']), 'Shift+СКМ');
});
test('mouse buttons and wheel are assignable; the wheel can only tap; the listen key must be a keyboard key', () => {
  for (const key of MOUSE_KEYS) assert.equal(config([{ phrase: 'удар', key, language: 'ru' }]).mappings[0].key, key);
  const wheel = config([{ phrase: 'удар', key: 'WHEEL_UP', language: 'ru', actionType: 'hold', durationMs: 900 }]).mappings[0];
  assert.deepEqual([wheel.actionType, wheel.durationMs], ['tap', 65]);
  const click = config([{ phrase: 'удар', key: 'MOUSE_LEFT', language: 'ru', actionType: 'hold', durationMs: 900 }]).mappings[0];
  assert.deepEqual([click.actionType, click.durationMs], ['hold', 900]);
  assert.throws(() => validateConfig({ ...DEFAULTS, holdKey: 'MOUSE_LEFT' }), /клавишу клавиатуры/);
});
test('defaults add sound, theme and tray options; broken values fall back', () => {
  const valid = validateConfig({ ...DEFAULTS, sound: { volume: 900, enabled: 'x' }, theme: 'purple' });
  assert.deepEqual([valid.sound, valid.theme, valid.closeToTray], [{ enabled: true, volume: 40, onMatch: true, onPress: true }, 'system', true]);
  assert.equal(validateConfig({ ...DEFAULTS, theme: 'dark', closeToTray: false }).closeToTray, false);
});
test('word mode reports unknown speech so the journal can assign it, but not repeats of commands', () => {
  const matcher = new WordCommandMatcher(DEFAULTS.mappings, 'ru', { wordStabilityMs: 0 });
  assert.equal(matcher.assess('кю', true).reason, 'no_command_word');
  const repeated = new WordCommandMatcher(DEFAULTS.mappings, 'ru', { wordStabilityMs: 0 }); repeated.assess('первый');
  assert.equal(repeated.assess('первый', true).reason, 'no_new_word_command');
});
test('firstSeenAt of a word action is the time the word first appeared', () => {
  let time = 1000; const matcher = new WordCommandMatcher(DEFAULTS.mappings, 'ru', { now: () => time, wordStabilityMs: 100 });
  matcher.assess('первый'); time = 1150;
  const action = matcher.assess('первый').actions[0];
  assert.deepEqual([action.firstSeenAt, action.stabilityMs], [1000, 150]);
});

function controller(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const events = [];
  const input = createKeyController({ down: key => (events.push(['down', key]), true), up: key => (events.push(['up', key]), true), isDown: () => false, modifiersDown: () => false, ...overrides }, { now: Date.now });
  return { input, events };
}
test('modifier goes down before the key and up after it', async t => {
  const { input, events } = controller(t); const result = input.perform({ key: 'Q', modifiers: ['SHIFT', 'CTRL'], durationMs: 65 });
  t.mock.timers.tick(65); await result;
  assert.deepEqual(events, [['down', 'CTRL'], ['down', 'SHIFT'], ['down', 'Q'], ['up', 'Q'], ['up', 'SHIFT'], ['up', 'CTRL']]);
});
test('a shared modifier stays down until the last action using it is released', async t => {
  const { input, events } = controller(t); const hold = input.perform({ key: 'Q', modifiers: ['CTRL'], durationMs: 1000 }), tap = input.perform({ key: 'W', modifiers: ['CTRL'], durationMs: 65 });
  t.mock.timers.tick(100); await tap; assert.equal(events.filter(event => event[0] === 'up' && event[1] === 'CTRL').length, 0);
  t.mock.timers.tick(900); await hold; assert.equal(events.filter(event => event[0] === 'down' && event[1] === 'CTRL').length, 1);
  assert.deepEqual(events.at(-1), ['up', 'CTRL']);
});
test('an action with another modifier set waits, so a held Ctrl never leaks into a plain command', async t => {
  const { input, events } = controller(t); const withCtrl = input.perform({ key: 'Q', modifiers: ['CTRL'], durationMs: 500 }), plain = input.perform({ key: 'W', durationMs: 65 });
  t.mock.timers.tick(200); assert.deepEqual(input.activeKeys(), ['Q']); assert.equal(events.some(event => event[1] === 'W'), false);
  t.mock.timers.tick(300); t.mock.timers.tick(100); await withCtrl; await plain;
  const order = events.map(event => event.join(':'));
  assert.ok(order.indexOf('up:CTRL') < order.indexOf('down:W'), order.join(' '));
});
test('modifiers held by the controller do not count as manual input, physical ones do', async t => {
  const seen = []; let physical = false;
  const { input, events } = controller(t, { modifiersDown: exclude => (seen.push([...exclude]), physical) });
  const hold = input.perform({ key: 'Q', modifiers: ['CTRL'], durationMs: 500 }), second = input.perform({ key: 'W', modifiers: ['CTRL'], durationMs: 65 });
  t.mock.timers.tick(100); await second; assert.ok(seen.some(list => list.includes('CTRL')));
  physical = true; const blocked = input.perform({ key: 'E', modifiers: ['CTRL'], durationMs: 65 }); t.mock.timers.tick(500); await hold;
  t.mock.timers.tick(200); assert.equal(events.some(event => event[1] === 'E'), false); physical = false; t.mock.timers.tick(40); t.mock.timers.tick(65); assert.equal((await blocked).ok, true);
});
test('emergency stop releases held modifiers too', async t => {
  const { input, events } = controller(t); const result = input.perform({ key: 'Q', modifiers: ['CTRL', 'ALT'], durationMs: 5000 });
  t.mock.timers.tick(50); input.cancelAll(); assert.equal((await result).cancelled, true);
  assert.deepEqual(events.slice(-3), [['up', 'Q'], ['up', 'ALT'], ['up', 'CTRL']]);
});
test('a rejected modifier press rolls back and reports the failure', async t => {
  const { input, events } = controller(t, { down: key => key !== 'ALT' });
  const result = await input.perform({ key: 'Q', modifiers: ['CTRL', 'ALT'], durationMs: 65 });
  assert.equal(result.ok, false); assert.equal(events.some(event => event[0] === 'up' && event[1] === 'CTRL'), true);
});
test('unknown modifiers are refused', async () => {
  const input = createKeyController({ down: () => true, up: () => true, isDown: () => false, modifiersDown: () => false });
  assert.equal((await input.perform({ key: 'Q', modifiers: ['WIN'], durationMs: 65 })).ok, false);
});

test('profiles export, import with unique names, and keep modifiers', () => {
  let store = validateStore({ ...DEFAULTS, mappings: [{ phrase: 'удар', key: 'T', language: 'ru', modifiers: ['SHIFT'] }] });
  store = changeProfile(store, { operation: 'create', name: 'Deadlock' });
  const one = exportProfiles(store, 'current'), all = exportProfiles(store, 'all');
  assert.equal(one.profiles.length, 1); assert.equal(all.profiles.length, 2);
  const imported = importProfiles(store, JSON.parse(JSON.stringify(all)));
  assert.deepEqual(imported.added, ['Общий (2)', 'Deadlock (2)']);
  assert.equal(imported.store.profiles.length, 4);
  assert.deepEqual(imported.store.profiles.find(profile => profile.name === 'Общий (2)').settings.mappings[0].modifiers, ['SHIFT']);
  assert.equal(imported.store.activeProfileId, store.activeProfileId);
});
test('import rejects foreign files and invalid profile settings without changing anything', () => {
  const store = validateStore(DEFAULTS);
  assert.throws(() => importProfiles(store, { hello: 1 }), /не файл профилей/);
  assert.throws(() => importProfiles(store, { format: 'voice-keys-profiles', profiles: [{ name: 'Плохой', settings: { language: 'de' } }] }), /Профиль «Плохой»/);
  assert.equal(store.profiles.length, 1);
});
test('one app icon everywhere: green rounded square with a white dot, the same in the exe, tray, window and page', () => {
  const size = 32, bitmap = drawAppIcon(size), at = (x, y) => (y * size + x) * 4;
  assert.equal(bitmap.length, size * size * 4);
  assert.equal(bitmap[at(0, 0) + 3], 0, 'corners are transparent');
  const centre = at(16, 16), edge = at(16, 3);
  assert.deepEqual([bitmap[centre], bitmap[centre + 1], bitmap[centre + 2], bitmap[centre + 3]], [255, 255, 255, 255], 'white dot in the middle');
  assert.deepEqual([bitmap[edge + 2], bitmap[edge + 1], bitmap[edge], bitmap[edge + 3]], [0x1f, 0x9d, 0x6b, 255], 'green background');
  assert.deepEqual(drawAppIcon(256), drawAppIcon(256));
  const grey = drawAppIcon(size, GREY);
  assert.deepEqual([grey[edge + 2], grey[edge + 1], grey[edge]], [0x8a, 0x94, 0x8d], 'tray is grey while not listening');
  assert.deepEqual([grey[centre], grey[centre + 1], grey[centre + 2]], [255, 255, 255], 'the white dot stays in the grey tray icon');
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  assert.ok(html.includes('rx="24" fill="#1f9d6b"') && html.includes('r="20" fill="#fff"'), 'page header logo uses the same colours');
  assert.ok(html.includes(encodeURIComponent('fill="#1f9d6b"')), 'favicon uses the same colours');
  assert.ok(!/class="logo">vk/.test(html), 'the old text logo is gone');
  const ico = require('../scripts/make-icon').build(), count = ico.readUInt16LE(4), first = ico.readUInt32LE(6 + 12), sizeOfFirst = ico[6];
  assert.equal(count, 6); assert.equal(sizeOfFirst, 16);
  const dibOffset = first + 40; // 16 px entry: BITMAPINFOHEADER, then bottom-up BGRA rows
  const centreDib = dibOffset + (7 * 16 + 8) * 4;
  assert.deepEqual([ico[centreDib], ico[centreDib + 1], ico[centreDib + 2]], [255, 255, 255], 'exe icon has the white dot too');
});

test('themes: one stylesheet with a warm light and a warm dark palette; the dark theme is not green-grey', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'style.css'), 'utf8');
  const palette = name => { const block = css.slice(css.indexOf(name)); return Object.fromEntries([...block.slice(0, block.indexOf('}')).matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)].map(m => [m[1], m[2]])); };
  const light = palette(':root {'), dark = palette(':root[data-theme=dark] {');
  const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  for (const [name, colors] of [['light', light], ['dark', dark]]) for (const key of ['bg', 'surface', 'field', 'line', 'text']) {
    const [r, g, b] = channels(colors[key]);
    assert.ok(r >= g && g >= b, `${name} ${key} ${colors[key]} is warm (red >= green >= blue)`);
  }
  assert.ok(channels(light.bg).every(c => c > 220), 'the light page is a light beige');
  assert.ok(channels(dark.bg).every(c => c < 50), 'the dark page is dark');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'ui', 'style-dark.css')));
});
