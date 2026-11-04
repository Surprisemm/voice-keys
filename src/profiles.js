'use strict';
const { randomUUID } = require('node:crypto');
const { DEFAULTS, validateConfig } = require('./core');
// A profile holds its commands and the words of its neural network. Model, language, modes, timings, microphone, overlay and the rest belong to the whole app.
// The general profile is always there and cannot be deleted or renamed: its network is the shared one and it knows every recorded word
// (its own list of words is not used: the whole library counts).
const GENERAL_ID = 'profile-default', GENERAL_NAME = 'Общий';
const FIELDS = ['mappings', 'neuralWords'];
const pick = value => Object.fromEntries(FIELDS.map(key => [key, structuredClone(value[key] ?? DEFAULTS[key] ?? [])]));
const emptyProfile = (id, name) => ({ id, name, settings: { mappings: [], neuralWords: [] } });
function validateStore(input, { requireLanguage = true } = {}) {
  const base = validateConfig(input, { requireLanguage });
  let profiles = Array.isArray(input.profiles) && input.profiles.length ? input.profiles : [{ id: GENERAL_ID, name: GENERAL_NAME, settings: pick(base) }];
  if (!profiles.some(profile => profile.id === GENERAL_ID)) profiles = [emptyProfile(GENERAL_ID, GENERAL_NAME), ...profiles];
  if (profiles.length > 50) throw new Error('Допустимо до 50 профилей.');
  const ids = new Set(), names = new Set();
  const validated = profiles.map(profile => {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(profile.id) || ids.has(profile.id)) throw new Error('Некорректный идентификатор профиля.');
    const name = profile.id === GENERAL_ID ? GENERAL_NAME : String(profile.name || '').trim();
    if (!name || name.length > 40 || names.has(name.toLowerCase())) throw new Error('Названия профилей должны быть уникальны, от 1 до 40 символов.');
    ids.add(profile.id); names.add(name.toLowerCase());
    return { id: profile.id, name, settings: pick(validateConfig({ ...base, mappings: profile.settings?.mappings ?? [], neuralWords: profile.settings?.neuralWords ?? [] }, { requireLanguage: false })) };
  });
  const activeProfileId = ids.has(input.activeProfileId) ? input.activeProfileId : validated[0].id;
  validated.find(profile => profile.id === activeProfileId).settings = pick(base);
  return { ...base, activeProfileId, profiles: validated };
}
function changeProfile(store, { operation, id, name, copy = false }) {
  const next = structuredClone(validateStore(store));
  const label = String(name || '').trim();
  if (operation === 'create' || operation === 'duplicate') {
    // duplicate: a copy of the profile `id` (its commands and words), not necessarily the active one
    const source = operation === 'duplicate' ? next.profiles.find(profile => profile.id === id) : null;
    if (operation === 'duplicate' && !source) throw new Error('Профиль не найден.');
    const profile = { id: randomUUID(), name: label, settings: pick(source ? source.settings : copy ? next : { ...DEFAULTS, mappings: [], neuralWords: [] }) };
    next.profiles.push(profile); id = profile.id;
  } else if (operation === 'rename') {
    if (id === GENERAL_ID) throw new Error('Общий профиль переименовать нельзя.');
    const profile = next.profiles.find(profile => profile.id === id); if (!profile) throw new Error('Профиль не найден.'); profile.name = label;
    return validateStore(next);
  } else if (operation === 'delete') {
    if (id === GENERAL_ID) throw new Error('Общий профиль удалить нельзя.');
    if (!next.profiles.some(profile => profile.id === id)) throw new Error('Профиль не найден.');
    next.profiles = next.profiles.filter(profile => profile.id !== id);
    id = next.activeProfileId === id ? GENERAL_ID : next.activeProfileId;
  } else if (operation !== 'switch') throw new Error('Неизвестное действие профиля.');
  const selected = next.profiles.find(profile => profile.id === id); if (!selected) throw new Error('Профиль не найден.');
  return validateStore({ ...next, mappings: selected.settings.mappings, neuralWords: selected.settings.neuralWords, activeProfileId: id }, { requireLanguage: false });
}
// Adds a neural word to a profile or takes it away (a command that used it forgets it). The active profile lives in the top-level fields of the store.
function changeProfileWords(store, { profileId, operation, word }) {
  const next = structuredClone(validateStore(store));
  const clean = validateConfig({ ...next, mappings: [], neuralWords: [word] }, { requireLanguage: false }).neuralWords[0];
  if (!clean) throw new Error('Нужно одно слово из букв и цифр.');
  const profile = next.profiles.find(item => item.id === profileId); if (!profile) throw new Error('Профиль не найден.');
  const target = profileId === next.activeProfileId ? next : profile.settings;
  if (operation === 'add') { if (!target.neuralWords.includes(clean)) target.neuralWords = [...target.neuralWords, clean]; }
  else if (operation === 'remove') { target.neuralWords = target.neuralWords.filter(item => item !== clean); for (const mapping of target.mappings) mapping.trainedWords = (mapping.trainedWords || []).filter(item => item !== clean); }
  else throw new Error('Неизвестное действие со словом.');
  return validateStore(next, { requireLanguage: false });
}
const EXPORT_FORMAT = 'voice-keys-profiles';
// A profile file holds names and settings only. Audio samples and machine-specific data stay local.
function exportProfiles(store, scope = 'current') {
  const valid = validateStore(store);
  const list = scope === 'all' ? valid.profiles : valid.profiles.filter(profile => profile.id === valid.activeProfileId);
  return { format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), profiles: list.map(profile => ({ name: profile.name, settings: structuredClone(profile.settings) })) };
}
function importProfiles(store, data) {
  if (!data || data.format !== EXPORT_FORMAT || !Array.isArray(data.profiles) || !data.profiles.length) throw new Error('Это не файл профилей Voice Keys.');
  const next = structuredClone(validateStore(store)), added = [];
  const taken = new Set(next.profiles.map(profile => profile.name.toLowerCase()));
  for (const item of data.profiles) {
    const label = String(item?.name || 'Импорт').trim().slice(0, 40) || 'Импорт';
    if (next.profiles.length >= 50) throw new Error('Допустимо до 50 профилей.');
    let settings;
    try { settings = pick(validateConfig({ ...next, mappings: item?.settings?.mappings, neuralWords: item?.settings?.neuralWords }, { requireLanguage: false })); }
    catch (error) { throw new Error(`Профиль «${label}»: ${error.message}`); }
    let name = label;
    for (let copy = 2; taken.has(name.toLowerCase()); copy++) name = `${label.slice(0, 40 - String(copy).length - 3)} (${copy})`;
    taken.add(name.toLowerCase());
    next.profiles.push({ id: randomUUID(), name, settings }); added.push(name);
  }
  return { store: validateStore(next), added };
}
// A fresh install has one profile, the general one, with the commands of Deadlock: abilities on 1-4, heavy attack, light attack and block.
const command = (id, phrases, key, extra = {}) => ({ id, phrases, key, language: 'ru', ...extra });
const GENERAL_COMMANDS = [
  command('general-1', ['первый'], '1'), command('general-2', ['второй', 'вторый'], '2'), command('general-3', ['третий'], '3'), command('general-4', ['четвёртый'], '4'),
  command('general-heavy', ['хэви', 'тяж', 'тяжелый', 'тяш'], 'Q', { actionType: 'hold', durationMs: 1000 }),
  command('general-hit', ['удар', 'утар'], 'Q'),
  command('general-block', ['блог', 'док', 'блок', 'плог'], 'F')
];
function defaultStore(base = DEFAULTS) {
  const settings = { mappings: structuredClone(GENERAL_COMMANDS), neuralWords: [] };
  return validateStore({ ...structuredClone(base), mappings: structuredClone(GENERAL_COMMANDS), neuralWords: [], profiles: [{ id: GENERAL_ID, name: GENERAL_NAME, settings }], activeProfileId: GENERAL_ID });
}
module.exports = { validateStore, changeProfile, changeProfileWords, exportProfiles, importProfiles, defaultStore, GENERAL_ID, GENERAL_NAME };
