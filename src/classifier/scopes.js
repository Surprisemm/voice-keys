'use strict';
// Which words a network is trained on. The recordings are one library shared by every profile. A profile has a list of words
// (the neural words chosen for it); the general profile has no list of its own: it knows every recorded word and its network is the shared one.
const { GENERAL_ID } = require('../profiles');

const MIN_TAKES = 8, GOOD_TAKES = 30;

// the name of the network file of a profile
const scopeOf = profileId => profileId === GENERAL_ID ? 'shared' : profileId;
// the words of a profile; `library`: the words that have recordings
function profileWords(profile, library = []) {
  return profile.id === GENERAL_ID ? [...library].sort() : [...(profile.settings?.neuralWords || [])];
}
// What a training run of the profile would use and what is lacking. counts: { word: recordings }.
function trainingPlan(profileId, counts, profiles) {
  const profile = profiles.find(item => item.id === profileId);
  const empty = { ok: false, words: [], fewTakes: [], notRecorded: [], weak: [], scope: scopeOf(profileId) };
  if (!profile) return { ...empty, error: 'Профиль не найден.' };
  const wanted = profileWords(profile, Object.keys(counts));
  const words = wanted.filter(word => (counts[word] || 0) >= MIN_TAKES);
  const fewTakes = wanted.filter(word => (counts[word] || 0) > 0 && (counts[word] || 0) < MIN_TAKES);
  const notRecorded = wanted.filter(word => !counts[word]);
  const weak = words.filter(word => counts[word] < GOOD_TAKES); // enough to train, but fewer than the recommended number
  const error = !wanted.length ? 'В профиле нет слов: запишите их или добавьте из библиотеки (шаг 3).'
    : !words.length ? `Ни у одного слова профиля нет ${MIN_TAKES} записей: запишите слова (шаг 3).` : '';
  return { ok: words.length > 0, error, words, fewTakes, notRecorded, weak, scope: scopeOf(profileId) };
}
// The network that listens while `profileId` is active: its own if it is trained, otherwise the shared one (the general profile has only the shared one).
function chooseModel(profileId, models) {
  if (profileId !== GENERAL_ID && models?.[profileId]) return profileId;
  if (models?.shared) return 'shared';
  return null;
}
module.exports = { profileWords, trainingPlan, chooseModel, scopeOf, MIN_TAKES, GOOD_TAKES };
