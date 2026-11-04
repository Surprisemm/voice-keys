'use strict';
const { KEYS, MODIFIERS, monotonicNow } = require('./core');

// Ordered starts, independent releases. A repeated key waits for its preceding release.
// Modifiers (Ctrl/Shift/Alt) are shared by reference count: they go down with the first action that needs
// them and up with the last. Actions with a different modifier set never overlap, so a held Ctrl
// cannot turn an unrelated plain command into Ctrl+command.
function createKeyController(adapter, { now = monotonicNow, gapMs = 0, releaseGapMs = 0 } = {}) {
  const active = new Map(), queue = [], releasedAt = new Map(), heldModifiers = new Map();
  let timer = null, nextStart = 0, cancelling = false, watchTimer = null;
  const TOGGLE_WATCH_MS = 40, TOGGLE_GRACE_MS = 150;
  const interval = () => typeof gapMs === 'function' ? gapMs() : gapMs;
  const held = () => [...heldModifiers.keys()];
  const sameSet = (a, b) => a.length === b.length && a.every(name => b.includes(name));
  function schedule(delay) { if (timer !== null) return; timer = setTimeout(() => { timer = null; pump(); }, Math.max(1, delay)); }
  function release(name) { return adapter.up(name) || adapter.up(name); }
  function pressModifiers(names) {
    const pressed = [];
    for (const name of names) {
      const count = heldModifiers.get(name) || 0;
      if (count === 0 && !adapter.down(name)) { for (const done of pressed) dropModifier(done); return false; }
      heldModifiers.set(name, count + 1); pressed.push(name);
    }
    return true;
  }
  function dropModifier(name) {
    const count = (heldModifiers.get(name) || 0) - 1;
    if (count > 0) { heldModifiers.set(name, count); return true; }
    heldModifiers.delete(name); return release(name);
  }
  // A toggled key stays down until the command is said again or the user presses the key himself: his press and release
  // lift it in Windows, and the key then reads as up although this program never released it.
  function watchToggles() {
    if (watchTimer !== null || !toggling()) return;
    watchTimer = setTimeout(() => {
      watchTimer = null;
      for (const task of [...active.values()]) if (task.toggle && now() - task.startedAt > TOGGLE_GRACE_MS && !adapter.isDown(task.key)) finish(task.key, false, true);
      watchToggles();
    }, TOGGLE_WATCH_MS);
  }
  const toggling = () => [...active.values()].some(task => task.toggle);
  function finish(key, cancelled = false, manual = false) {
    const task = active.get(key); if (!task) return;
    clearTimeout(task.timer); active.delete(key);
    let ok = release(key); releasedAt.set(key, now());
    for (const name of [...task.modifiers].reverse()) ok = dropModifier(name) && ok;
    task.resolve({ ok, cancelled, manual, startedAt: task.startedAt, endedAt: now(), actualDurationMs: now() - task.startedAt, reason: ok ? '' : 'Windows не подтвердила отпускание клавиши.' });
    if (!cancelling) pump();
  }
  function pump() {
    if (cancelling || !queue.length) return;
    const task = queue[0];
    // saying a toggled command again lifts the key
    if (task.toggle && active.get(task.key)?.toggle) {
      queue.shift(); finish(task.key);
      task.resolve({ ok: true, toggledOff: true, startedAt: now(), endedAt: now(), actualDurationMs: 0, reason: '' }); pump(); return;
    }
    if (active.has(task.key)) return;
    if (active.size && !sameSet(task.modifiers, held())) return;
    const delay = Math.max(nextStart - now(), (releasedAt.get(task.key) ?? -Infinity) + releaseGapMs - now());
    if (delay > 0) { schedule(delay); return; }
    // Defer rather than discard a recognized command when manual input is held. Modifiers held by this
    // controller are ours and do not count.
    if (adapter.modifiersDown(held()) || adapter.isDown(task.key)) { schedule(20); return; }
    queue.shift();
    if (!pressModifiers(task.modifiers)) { task.resolve({ ok: false, reason: 'Windows отклонила ввод модификатора. Проверьте уровень прав приложения.' }); pump(); return; }
    if (!adapter.down(task.key)) {
      for (const name of [...task.modifiers].reverse()) dropModifier(name);
      task.resolve({ ok: false, reason: 'Windows отклонила ввод. Проверьте уровень прав приложения.' }); pump(); return;
    }
    task.startedAt = now(); active.set(task.key, task); nextStart = now() + interval();
    if (task.toggle) watchToggles(); else task.timer = setTimeout(() => finish(task.key), task.durationMs);
    try { task.onStarted?.({ key: task.key, modifiers: task.modifiers, startedAt: task.startedAt, durationMs: task.durationMs }); }
    catch (error) { finish(task.key, true); task.resolve({ ok: false, reason: error.message }); }
    pump();
  }
  function perform({ key, modifiers = [], durationMs = 65, actionType = 'tap' }, onStarted) {
    if (!KEYS.includes(key) || !Array.isArray(modifiers) || modifiers.some(name => !MODIFIERS.includes(name)) || !Number.isInteger(durationMs) || durationMs < 20 || durationMs > 10000) {
      return Promise.resolve({ ok: false, reason: 'Нужна одна клавиша, модификаторы Ctrl/Shift/Alt и длительность 20–10000 мс.' });
    }
    const ordered = MODIFIERS.filter(name => modifiers.includes(name));
    const promise = new Promise(resolve => queue.push({ key, modifiers: ordered, durationMs, toggle: actionType === 'toggle', onStarted, resolve })); pump(); return promise;
  }
  function cancelAll() {
    cancelling = true; if (timer !== null) clearTimeout(timer); timer = null; nextStart = 0;
    if (watchTimer !== null) clearTimeout(watchTimer); watchTimer = null;
    for (const task of queue.splice(0)) task.resolve({ ok: false, cancelled: true, reason: 'Прослушивание остановлено; ожидающее нажатие отменено.' });
    for (const key of [...active.keys()]) finish(key, true); cancelling = false;
  }
  return { perform, cancelAll, activeKeys: () => [...active.keys()], pendingKeys: () => queue.map(task => task.key) };
}
module.exports = { createKeyController };
