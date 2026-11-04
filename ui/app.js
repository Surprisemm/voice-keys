'use strict';
const $ = id => document.getElementById(id);
const { KEYS, KEYBOARD_KEYS, MODIFIERS, MODIFIER_LABELS, KEY_DESCRIPTIONS, normalize, cleanPhrase, speechKey, phraseList, isWheel, actionLabel } = window.VoiceKeysCore;
const { microphoneOptions } = window.VoiceKeysMicrophones;
let config, currentState, dirty = false, busy = false, ready = false;
const models = new Map();
let model, stream, audio, source, processor, recognizer, finishTimer;
let finishing = [], liveEpoch = 0, historyEntries = [], capturingButton = null;
let preparedLanguage, preparedMicrophone, refreshingMics = false;
async function installModel(id) {
  const title = installedModels.catalog?.[id]?.title || id; busy = true; updateControls(); notice(`Скачиваю модель «${title}»… Это может занять несколько минут.`, true);
  const result = await window.voiceKeys.installModel(id); busy = false; installedModels = result.models || installedModels; updateControls();
  notice(result.ok ? `Модель «${title}» скачана.` : `Не удалось скачать модель: ${result.error}`, result.ok);
}
// every model with its licence, size and state: download it, or choose it when it is already here
function renderModelTable(locked) {
  const table = $('model-table'), catalog = installedModels.catalog; if (!catalog) return;
  table.replaceChildren();
  for (const [id, entry] of Object.entries(catalog)) {
    const have = Boolean(installedModels.installed?.[id]), vosk = /^vosk-(ru|en)$/.exec(id), current = neededModel() === id;
    const row = document.createElement('div'); row.className = `model-row-item${current ? ' current' : ''}`; row.setAttribute('role', 'row');
    const info = document.createElement('div'); info.className = 'model-info';
    const name = document.createElement('strong'); name.textContent = entry.title; const meta = document.createElement('span'); meta.textContent = `лицензия ${entry.license} · ${entry.sizeMb} МБ · ${entry.source}`; info.append(name, meta);
    const state = document.createElement('span'); state.className = `model-state ${have ? 'good' : 'warn'}`; state.textContent = have ? 'скачана' : 'не скачана';
    const button = document.createElement('button'); button.type = 'button'; button.className = `button ${have ? 'subtle' : 'primary'}`; button.disabled = busy || locked || (have && current);
    button.textContent = !have ? 'Скачать' : current ? 'Выбрана' : 'Выбрать';
    button.onclick = () => {
      if (!have) { installModel(id); return; }
      $('model').value = vosk ? 'vosk' : id; $('language').value = vosk ? vosk[1] : 'ru';
      updateRows(); markDirty(); updateControls();
    };
    row.append(info, state, button); table.append(row);
  }
}
const neededModel = () => $('model').value === 'vosk' ? `vosk-${$('language').value}` : $('model').value;
const modelReady = () => !installedModels.installed || Boolean(installedModels.installed[neededModel()]);
let preparedModel, preparedSpeechEnd, preparedCapture, installedModels = {}, segmentCounter = 0;
// Audio source: Chromium (AudioWorklet) or the native WASAPI helper. captureRate is the rate of the blocks being fed to the recognizer.
let captureRate = 48000, nativeCapture = null, audioTap = null; // audioTap(samples): the classifier recorder listens to the blocks
let voskText = '', waitingFinal = false, bufferedAudio = [], lastVoiceAt = 0, lastTextAt = 0;
let displayedActionId = null;
let flushedVoiceAt = 0;
let sampleRecorder=null,sampleList=[],profileOperation='create',profileTarget='';
const ENROLL_REPEATS = 3, ORDINALS = ['первый', 'второй', 'третий'];
let enrollment = null;
const isLive = () => Boolean(currentState?.listening || enrollment && !enrollment.done);
const rowPhrases = row => phraseList({ phrase: row.querySelector('.row-phrase').value });
// ---------- neural words of the commands ----------
// A command has the text phrases (for the recognizer) and its own neural words (for the personal classifier). classifier.js keeps
// `neuralInfo` current: { words: recordings per word, models, activeProfileId }.
const NEURAL_MIN = 8, NEW_WORD = '\u0000new';
let neuralInfo = null;
const NEURAL_TITLES = { trained: 'Сеть обучена на этом слове.', untrained: 'Слово записано, но сеть ещё не обучена на нём: переобучите сеть.', norecord: 'Записей мало или нет: запишите слово (раздел «Свой классификатор голоса», шаг 2).' };
// What the network of a profile knows about these words. level: empty | none (no network) | stale (some words are not in it) | ok.
function neuralCoverage(words, info, profileId) {
  const counts = info?.words || {}, models = info?.models || {}, scope = models[profileId] ? profileId : models.shared ? 'shared' : null, model = scope ? models[scope] : null;
  const known = new Set(model?.words || []);
  const states = words.map(word => ({ word, count: counts[word] || 0, state: (counts[word] || 0) < NEURAL_MIN ? 'norecord' : known.has(word) ? 'trained' : 'untrained' }));
  const missing = states.filter(item => item.state === 'untrained').map(item => item.word), norecord = states.filter(item => item.state === 'norecord').map(item => item.word);
  const empty = states.filter(item => item.state === 'norecord' && !item.count).map(item => item.word); // words nobody has recorded yet
  const takes = model?.takes; // recordings per word at the time of training (absent for networks trained by older versions)
  const newer = takes ? states.filter(item => item.state === 'trained' && item.count > (takes[item.word] || 0)).map(item => item.word) : [];
  const level = !words.length ? 'empty' : !model ? 'none' : missing.length || norecord.length || newer.length ? 'stale' : 'ok';
  return { scope, model, states, missing, norecord, empty, newer, level };
}
window.neuralCoverage = neuralCoverage;
const rowNeural = row => { try { return JSON.parse(row.dataset.trained || '[]'); } catch { return []; } };
function openClassifier(focusNewWord = false) {
  const panel = $('classifier-panel'); if (!panel.open) { panel.open = true; panel.dispatchEvent(new Event('toggle')); }
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); if (focusNewWord) setTimeout(() => $('cls-new-word')?.focus(), 500);
}
function setNeural(row, list) { row.dataset.trained = JSON.stringify(list); renderNeural(row); updateNetBadge(); markDirty(); }
function renderNeural(row) {
  const box = row.querySelector('.neural-box'); if (!box) return;
  const words = rowNeural(row), cover = neuralCoverage(words, neuralInfo, neuralInfo?.activeProfileId);
  box.replaceChildren(); box.hidden = !words.length;
  for (const item of cover.states) {
    const chip = document.createElement('span'); chip.className = `neural-chip s-${item.state}`; chip.title = item.state === 'norecord' && item.count ? `Записей ${item.count} из ${NEURAL_MIN} минимум. ${NEURAL_TITLES.norecord}` : NEURAL_TITLES[item.state];
    const text = document.createElement('span'); text.textContent = item.word;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Убрать слово ${item.word}`); remove.title = 'Убрать слово из команды';
    remove.onclick = () => setNeural(row, words.filter(word => word !== item.word));
    chip.append(text, remove); box.append(chip);
  }
  row.querySelector('.neural-add')?.remove();
  const add = document.createElement('select'); add.className = 'neural-add'; add.setAttribute('aria-label', 'Добавить слово нейросети');
  add.title = 'Слова нейросети: добавить записанное слово из библиотеки классификатора. Текстовое поле слева — для обычного распознавания. Команду выполняет тот, кто узнал её первым; второй раз она не нажмётся.';
  add.append(option('', '＋'));
  const own = neuralInfo?.profiles?.find(profile => profile.id === neuralInfo.activeProfileId)?.words ?? Object.keys(neuralInfo?.words || {}).sort(); // the words of this profile
  for (const word of own) if (!words.includes(word)) add.append(option(word, `${word} · ${neuralInfo?.words?.[word] || 0}`));
  add.append(option(NEW_WORD, '✎ Записать новое слово…'));
  add.onchange = () => { const value = add.value; add.value = ''; if (value === NEW_WORD) openClassifier(true); else if (value && !words.includes(value)) setNeural(row, [...words, value]); };
  row.querySelector('.phrase-box').append(add);
}
window.onClassifierInfo = info => { neuralInfo = info; for (const row of document.querySelectorAll('#mappings tr')) renderNeural(row); updateNetBadge(); };
const NET_BADGE = { empty: ['', ''], none: ['bad', 'Нейросеть не обучена'], stale: ['warn', 'Сеть устарела'], ok: ['good', 'Нейросеть обучена'] };
function updateNetBadge() {
  const badge = $('net-badge'); if (!badge) return;
  const profile = neuralInfo?.profiles?.find(item => item.id === neuralInfo.activeProfileId);
  const words = profile ? profile.words : [...new Set([...$('mappings').children].flatMap(rowNeural))], cover = neuralCoverage(words, neuralInfo, neuralInfo?.activeProfileId), [kind, text] = NET_BADGE[cover.level];
  badge.hidden = !text; badge.className = `net-badge ${kind}`; badge.textContent = text;
  const parts = [];
  if (cover.level === 'none') parts.push(cover.norecord.length ? `Нет записей или мало: ${cover.norecord.join(', ')}.` : 'Слова записаны, но сеть для этого профиля (и общая) ещё не обучена.');
  if (cover.level === 'stale') { if (cover.missing.length) parts.push(`Не вошли в обучение (записаны, но сеть их не знает): ${cover.missing.join(', ')}.`); if (cover.empty.length) parts.push(`Не записаны, в обучение не попали: ${cover.empty.join(', ')}.`); if (cover.norecord.length > cover.empty.length) parts.push(`Мало записей: ${cover.norecord.filter(word => !cover.empty.includes(word)).join(', ')}.`); if (cover.newer.length) parts.push(`Есть новые записи: ${cover.newer.join(', ')}.`); parts.push('Запишите недостающее и переобучите сеть.'); }
  if (cover.level === 'ok') parts.push(`Слушает ${cover.scope === 'shared' ? 'общая сеть' : 'сеть профиля'}, все слова профиля в ней есть.`);
  badge.title = [...parts, 'Нажмите, чтобы открыть раздел классификатора.'].join(' ');
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme(theme) { document.documentElement.dataset.theme = theme === 'dark' || theme === 'system' && darkQuery.matches ? 'dark' : 'light'; }
applyTheme('system'); darkQuery.addEventListener('change', () => applyTheme(config?.theme || 'system'));

function diagnose(event, detail = '') { window.voiceKeys.diagnose({ event, detail }); }
window.addEventListener('error', event => diagnose('ui.error', `${event.message}\n${event.error?.stack || ''}`));
window.addEventListener('unhandledrejection', event => diagnose('ui.unhandled_rejection', `${event.reason?.message || event.reason}\n${event.reason?.stack || ''}`));
function notice(message, success = false) { $('notice').textContent = message; $('notice').classList.toggle('success', success); $('notice').classList.toggle('hidden', !message); }
function option(value, text = value) { const element = document.createElement('option'); element.value = value; element.textContent = text; return element; }
function keyOptions(select, selected, keys = KEYS) {
  const named = key => option(key, KEY_DESCRIPTIONS[key] || key);
  const groups = [['Буквы и цифры', keys.filter(key => /^[A-Z0-9]$/.test(key))], ['F-клавиши', keys.filter(key => /^F\d/.test(key))],
    ['Другие клавиши', keys.filter(key => !/^[A-Z0-9]$|^F\d|^MOUSE_|^WHEEL_/.test(key))], ['Мышь', keys.filter(key => key.startsWith('MOUSE_'))], ['Колесо мыши', keys.filter(key => key.startsWith('WHEEL_'))]];
  for (const [label, list] of groups) { if (!list.length) continue; const group = document.createElement('optgroup'); group.label = label; for (const key of list) group.append(named(key)); select.append(group); }
  select.value = selected;
}
// Every change is saved by itself shortly after the last one. The form is not redrawn by an automatic save, so typing is never interrupted.
let autosaveTimer = null;
function markDirty() { dirty = true; $('settings-note').textContent = 'Сохраняю…'; $('settings-note').classList.remove('bad'); updateControls(); scheduleAutosave(); }
function scheduleAutosave(delay = 700) { clearTimeout(autosaveTimer); autosaveTimer = setTimeout(autosave, delay); }
async function autosave() {
  clearTimeout(autosaveTimer); autosaveTimer = null;
  if (!dirty) return;
  // never while listening (a save stops it), while something else is busy, or while a key is being captured; try again when it is over
  if (currentState?.armed) return;
  if (busy || enrollment || capturingButton) { scheduleAutosave(1000); return; }
  await save({ quiet: true });
}
function flushAutosave() { if (dirty && autosaveTimer) autosave(); }
function readForm() {
  const selected = $('microphone').selectedOptions[0];
  return { ...config, language: $('language').value, listenMode: $('listen-mode').value, holdKey: $('hold-key').value,
    confidenceThreshold: Number($('confidence').value), microphoneId: $('microphone').value, microphoneLabel: selected?.dataset.rawLabel || '',
    modelId: $('model').value, captureMode: $('capture-mode').value, classifierEnabled: $('classifier-enabled').checked, commandMode: $('command-mode').value, wordStabilityMs: Number($('word-stability').value), prefixMatch: $('prefix-match').checked, speechEndMs: Number($('speech-end').value),
    queueGapMs:Number($('queue-gap').value),overlay:{enabled:$('overlay-enabled').checked,orientation:$('overlay-orientation').value,anchor:$('overlay-anchor').value,offsetX:Number($('overlay-x').value),offsetY:Number($('overlay-y').value),size:Number($('overlay-size').value),retentionMs:Number($('overlay-retention').value)},
    mappings: [...$('mappings').children].map(row => ({ id: row.dataset.id, phrase: row.querySelector('.row-phrase').value, trainedWords: rowNeural(row), learned: JSON.parse(row.dataset.learned || '[]'), language: row.querySelector('.row-language').value, key: row.querySelector('.row-key').value, modifiers: [...row.querySelectorAll('.mod[aria-pressed=true]')].map(chip => chip.dataset.mod), actionType: row.querySelector('.row-action').value, durationMs: Number(row.querySelector('.row-duration').value) })) };
}
function updateRows() {
  const language = $('language').value; let shown = 0;
  for (const row of $('mappings').children) {
    row.hidden = row.querySelector('.row-language').value !== language; if (!row.hidden) shown++;
    const list = rowPhrases(row), phraseOnly = $('command-mode').value === 'words' && list.length > 0 && list.every(item => normalize(item).split(' ').length > 1);
    row.classList.toggle('phrase-only', phraseOnly); row.title = phraseOnly ? 'Это назначение работает только в режиме «Целая фраза».' : '';
  }
  $('count').textContent = `${shown} / ${$('mappings').children.length}`;
  $('commands-caption').textContent = `${language === 'ru' ? 'Русские' : 'English'} · ${$('command-mode').value === 'words' ? 'каждое слово → своё действие' : 'целая фраза → действие'}`;
  for(const row of $('mappings').children){if(isWheel(row.querySelector('.row-key').value))row.querySelector('.row-action').value='tap';const hold=row.querySelector('.row-action').value==='hold';row.querySelector('.hold-time').hidden=!hold;row.classList.toggle('is-hold',hold||row.querySelector('.row-action').value==='toggle');}
}
function addRow(mapping = { id: crypto.randomUUID(), phrase: '', key: 'Q', language: $('language').value }) {
  const row = document.createElement('tr'); row.dataset.id = mapping.id; row.dataset.learned = JSON.stringify(mapping.learned || []);
  const cells = Array.from({ length: 5 }, () => document.createElement('td')); cells[1].className = 'language-cell';
  const phrase = document.createElement('input'); phrase.className = 'row-phrase'; phrase.value = phraseList(mapping).join(', '); phrase.maxLength = 600; phrase.placeholder = 'Слова через запятую: ку, кью'; phrase.setAttribute('aria-label', 'Слова команды через запятую');
  phrase.title = 'Любое из этих слов нажмёт клавишу. Несколько вариантов — через запятую. Кнопка с микрофоном запишет ваше произношение.';
  const voice = document.createElement('button'); voice.className = 'voice-add'; voice.textContent = '🎙'; voice.title = 'Записать произношение голосом: скажите слово три раза'; voice.setAttribute('aria-label', 'Записать произношение голосом');
  voice.onclick = () => startEnrollment(row);
  const phraseBox = document.createElement('div'); phraseBox.className = 'phrase-box'; phraseBox.append(phrase, voice);
  const neural = document.createElement('div'); neural.className = 'neural-box';
  const language = document.createElement('select'); language.className = 'row-language'; language.append(option('ru', 'Русский'), option('en', 'English')); language.value = mapping.language; language.setAttribute('aria-label', 'Язык фразы');
  const key = document.createElement('select'); key.className = 'row-key'; keyOptions(key, mapping.key); key.setAttribute('aria-label', 'Клавиша команды');
  const capture = document.createElement('button'); capture.className = 'capture'; capture.textContent = '⌨'; capture.title = 'Нажмите, затем нужную клавишу, сочетание с Ctrl/Shift/Alt, кнопку мыши (средняя, боковые) или прокрутите колесо. Esc отменяет.'; capture.setAttribute('aria-label', 'Назначить нажатием клавиши');
  capture.onclick = () => { cancelCapture(); capturingButton = capture; capture.classList.add('waiting'); capture.textContent = '…'; notice('Нажмите клавишу или сочетание, среднюю или боковую кнопку мыши, либо прокрутите колесо. Esc — отмена.'); };
  const mods = document.createElement('div'); mods.className = 'mods'; mods.setAttribute('role', 'group'); mods.setAttribute('aria-label', 'Модификаторы');
  for (const name of MODIFIERS) {
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'mod'; chip.dataset.mod = name; chip.textContent = MODIFIER_LABELS[name];
    chip.setAttribute('aria-pressed', String((mapping.modifiers || []).includes(name))); chip.title = `Удерживать ${MODIFIER_LABELS[name]} вместе с клавишей`;
    chip.onclick = () => { chip.setAttribute('aria-pressed', String(chip.getAttribute('aria-pressed') !== 'true')); markDirty(); }; mods.append(chip);
  }
  const picker = document.createElement('div'); picker.className = 'key-picker'; picker.append(mods, key, capture);
  const action = document.createElement('select'); action.className = 'row-action'; action.append(option('tap', 'Нажать'), option('hold', 'Удержать'), option('toggle', 'Переключить')); action.value = mapping.actionType || 'tap'; action.setAttribute('aria-label', 'Тип действия'); action.title = 'Нажать — короткое нажатие. Удержать — держать заданное время. Переключить — зажать клавишу до повторной команды или до вашего нажатия на неё.';
  const duration = document.createElement('input'); duration.type = 'number'; duration.className = 'row-duration'; duration.min = '20'; duration.max = '10000'; duration.step = '10'; duration.value = mapping.actionType === 'hold' ? mapping.durationMs ?? 1000 : 65; duration.setAttribute('aria-label', 'Длительность удержания в миллисекундах');
  duration.disabled = action.value !== 'hold';
  action.onchange = () => { if(action.value==='hold'&&Number(duration.value)===65)duration.value=1000;updateRows();markDirty(); };
  duration.oninput = markDirty;
  const remove = document.createElement('button'); remove.className = 'remove'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Удалить назначение'); remove.title = 'Удалить';
  remove.onclick = () => { cancelCapture(); row.remove(); updateRows(); markDirty(); };
  phrase.oninput = () => { updateRows(); markDirty(); }; language.onchange = () => { updateRows(); markDirty(); }; key.onchange = () => { updateRows(); markDirty(); };
  const holdTime = document.createElement('label'); holdTime.className = 'hold-time'; holdTime.title = 'Сколько миллисекунд держать клавишу'; holdTime.append(duration, document.createTextNode('мс'));
  const actionBox = document.createElement('div'); actionBox.className = 'action-box'; actionBox.append(action, holdTime);
  cells[0].append(phraseBox, neural); cells[1].append(language); cells[2].append(picker); cells[3].append(actionBox); cells[4].append(remove); row.append(...cells); row.dataset.trained = JSON.stringify(window.VoiceKeysCore.trainedList(mapping)); $('mappings').append(row); renderNeural(row); updateRows(); return phrase;
}
function cancelCapture() { if (capturingButton) { capturingButton.classList.remove('waiting'); capturingButton.textContent = '⌨'; capturingButton = null; } }
function keyFromCode(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3); if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F\d+$/.test(code)) return KEYS.includes(code) ? code : null; if (/^Numpad\d$/.test(code)) return 'NUM' + code.slice(6);
  return { Space: 'SPACE', Tab: 'TAB', Enter: 'ENTER', Backspace: 'BACKSPACE', Delete: 'DELETE', Insert: 'INSERT', Home: 'HOME', End: 'END', PageUp: 'PAGEUP', PageDown: 'PAGEDOWN', ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', NumpadAdd: 'NUMADD', NumpadSubtract: 'NUMSUBTRACT', NumpadMultiply: 'NUMMULTIPLY', NumpadDivide: 'NUMDIVIDE', NumpadDecimal: 'NUMDECIMAL', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`' }[code] || null;
}
const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);
function assignCaptured(key, modifiers) {
  const row = capturingButton.closest('tr'); row.querySelector('.row-key').value = key;
  for (const chip of row.querySelectorAll('.mod')) chip.setAttribute('aria-pressed', String(modifiers.includes(chip.dataset.mod)));
  cancelCapture(); updateRows(); markDirty(); notice(`Назначено: ${actionLabel(key, modifiers)}.`, true);
}
const heldModifiers = event => [event.ctrlKey && 'CTRL', event.shiftKey && 'SHIFT', event.altKey && 'ALT'].filter(Boolean);
document.addEventListener('keydown', event => {
  if (!capturingButton) return; event.preventDefault(); event.stopImmediatePropagation();
  if (event.code === 'Escape') { cancelCapture(); notice(''); return; }
  if (MODIFIER_CODES.has(event.code)) return;
  if (event.metaKey) { notice('Win в сочетаниях не поддерживается: используйте Ctrl, Shift или Alt.'); return; }
  const key = keyFromCode(event.code); if (!key) { notice('Эта клавиша не поддерживается. Выберите её из списка, если она там есть.'); return; }
  assignCaptured(key, heldModifiers(event));
}, true);
document.addEventListener('mousedown', event => {
  if (!capturingButton || event.target === capturingButton) return;
  const key = { 1: 'MOUSE_MIDDLE', 3: 'MOUSE_X1', 4: 'MOUSE_X2' }[event.button];
  if (!key) return; event.preventDefault(); event.stopImmediatePropagation(); assignCaptured(key, heldModifiers(event));
}, true);
document.addEventListener('wheel', event => {
  if (!capturingButton) return; event.preventDefault();
  const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
  assignCaptured(vertical ? (event.deltaY < 0 ? 'WHEEL_UP' : 'WHEEL_DOWN') : (event.deltaX < 0 ? 'WHEEL_LEFT' : 'WHEEL_RIGHT'), heldModifiers(event));
}, { capture: true, passive: false });
function updateMode() {
  const preview = config.outputMode === 'preview';
  for (const [id, selected] of [['mode-preview', preview], ['mode-keyboard', !preview]]) { $(id).classList.toggle('selected', selected); $(id).setAttribute('aria-pressed', String(selected)); }
  $('mode-description').textContent = preview ? 'Результат виден здесь. Ввод в Windows выключен.' : 'Одна клавиша отправляется в активное окно Windows.';
  $('real-input').open = !preview;
}
function renderConfig() {
  $('language').value = config.language; $('listen-mode').value = config.listenMode; $('hold-key').value = config.holdKey; $('confidence').value = String(config.confidenceThreshold ?? 0.85);
  $('model').value = config.modelId || 'vosk'; $('capture-mode').value = config.captureMode || 'chromium'; $('classifier-enabled').checked = config.classifierEnabled === true; $('command-mode').value = config.commandMode || 'phrase'; $('word-stability').value = config.wordStabilityMs ?? 100; $('prefix-match').checked = config.prefixMatch !== false; $('speech-end').value = config.speechEndMs || 250;
  $('queue-gap').value=config.queueGapMs||80;const overlay=config.overlay||window.VoiceKeysCore.DEFAULTS.overlay;
  $('overlay-enabled').checked=overlay.enabled;$('overlay-orientation').value=overlay.orientation;$('overlay-anchor').value=overlay.anchor;$('overlay-x').value=overlay.offsetX;$('overlay-y').value=overlay.offsetY;$('overlay-size').value=overlay.size;$('overlay-retention').value=overlay.retentionMs;renderProfiles();renderPrefs();
  if (![...$('microphone').options].some(item => item.value === config.microphoneId)) { const unavailable = option(config.microphoneId, config.microphoneLabel || 'Ранее выбранный микрофон'); unavailable.dataset.rawLabel = config.microphoneLabel || ''; $('microphone').append(unavailable); }
  $('microphone').value = config.microphoneId; $('mappings').replaceChildren(); for (const mapping of config.mappings) addRow(mapping); updateMode(); updateRows();
}
function updateControls() {
  const locked = Boolean(currentState?.armed || busy || enrollment);
  for (const element of document.querySelectorAll('#mappings input,#mappings select,#mappings button,#language,#microphone,#listen-mode,#hold-key,#confidence,#add,#save,#refresh-mics,#mode-preview,#mode-keyboard,#model,#capture-mode,#classifier-enabled,#command-mode,#word-stability,#prefix-match,#speech-end')) element.disabled = locked;
  for (const row of $('mappings').children) row.querySelector('.row-duration').disabled = locked || row.querySelector('.row-action').value === 'tap';
  for(const element of document.querySelectorAll('.overlay-settings input,.overlay-settings select,#queue-gap,#overlay-demo'))element.disabled=locked;
  for(const id of ['profile-select','profile-new','profile-duplicate','profile-rename','profile-delete','profile-export','profile-import'])$(id).disabled=busy||Boolean(enrollment);
  for(const row of $('mappings').children)row.querySelector('.row-action').disabled=locked||isWheel(row.querySelector('.row-key').value);
  if(config?.activeProfileId==='profile-default'){$('profile-rename').disabled=true;$('profile-delete').disabled=true;}
  $('sample-text').disabled=locked;$('sample-record').disabled=locked&&!sampleRecorder;
  for(const id of ['sample-select','sample-play','sample-test','sample-delete'])$(id).disabled=locked||!sampleList.length;
  $('hold-key').disabled = locked || $('listen-mode').value === 'always'; $('save').disabled = $('save-settings').disabled = locked || !dirty; document.querySelector('.hold-label').hidden = $('listen-mode').value !== 'hold'; $('start').disabled = busy || Boolean(enrollment);
  $('start').textContent = busy ? 'Подготовка…' : ready ? 'Включить' : 'Включить микрофон'; $('refresh-mics').disabled = locked || refreshingMics;
  const wordsMode = $('command-mode').value === 'words', nativeModel = $('model').value !== 'vosk', modelName = { sherpa: 'T-one', gigaam: 'GigaAM' }[$('model').value];
  $('confidence').disabled = locked || wordsMode || nativeModel; $('word-stability').disabled = locked || !wordsMode; $('prefix-match').disabled = locked || !wordsMode; $('speech-end').disabled = locked || wordsMode;
  for (const id of ['sherpa', 'gigaam']) $('model').querySelector(`[value="${id}"]`).disabled = $('language').value !== 'ru';
  const need = neededModel(), entry = installedModels.catalog?.[need], have = modelReady();
  $('model-banner').classList.toggle('hidden', have); $('model-banner-install').disabled = busy || locked; $('model-banner-install').textContent = busy ? 'Скачиваю…' : `Скачать${entry ? ` · ${entry.sizeMb} МБ` : ''}`;
  $('model-banner-text').textContent = entry ? `Для распознавания нужна модель «${entry.title}» (лицензия ${entry.license}). Она не входит в программу и скачивается один раз.` : '';
  renderModelTable(locked);
  $('recognition-hint').textContent = (wordsMode ? 'Слова выполняются по отдельности, в том числе внутри предложения. Многословные назначения пропускаются.' : 'Выполняется только совпавшая целая фраза после паузы.') + (nativeModel ? ` ${modelName} не возвращает оценку уверенности.${$('model').value === 'gigaam' ? ' GigaAM слушает фразу целиком и обновляет текст по ходу речи.' : ''}` : wordsMode ? ' Быстрый режим использует стабильный предварительный текст без оценки уверенности.' : ' Vosk проверяет уверенность результата.');
  if (displayedActionId === null) $('last-result').textContent = wordsMode ? 'Говорите команды подряд: каждое слово выполняется отдельно.' : 'Скажите фразу и сделайте короткую паузу.';
}
function applyState(value) {
  const previous = currentState; currentState = value; $('status-pill').classList.toggle('active', value.armed);
  $('status').textContent = value.listening ? 'Слушаю' : value.armed ? `Держите ${value.holdKey}` : 'Выключено';
  $('start').classList.toggle('hidden', value.armed); $('stop').classList.toggle('hidden', !value.armed);
  if (ready) $('listen-status').textContent = value.listening ? config.commandMode === 'words' ? 'Слушаю каждое слово отдельно.' : 'Слушаю. После команды сделайте короткую паузу.' : value.armed ? `Удерживайте ${value.holdKey} и говорите` : 'Готово к включению.';
  if (value.listening && (!previous?.listening || value.epoch !== liveEpoch)) beginUtterance(value.epoch);
  else if (!value.listening && previous?.listening) endListening(value.armed);
  if (!value.armed) cancelUtterance(); updateControls(); window.classifierOnState?.(value);
  if (dirty && !value.armed && !autosaveTimer) scheduleAutosave(300);
}
function cancelUtterance() { clearTimeout(finishTimer); if (recognizer) { recognizer.remove(); recognizer = null; } for (const item of finishing) item.remove(); finishing = []; waitingFinal = false; bufferedAudio = []; voskText = ''; window.voiceKeys.stopEngine(); }
function beginUtterance(epoch) {
  cancelUtterance(); liveEpoch = epoch; segmentCounter = 0; lastVoiceAt = 0; flushedVoiceAt = 0;
  diagnose('recognizer.started', `epoch=${epoch}; language=${config.language}; model=${config.modelId}; mode=${config.commandMode}`);
  if (config.modelId !== 'vosk') { window.voiceKeys.startEngine({ epoch }); return; }
  createVoskRecognizer();
}
function createVoskRecognizer() {
  const epoch = liveEpoch, segmentId = segmentCounter++;
  recognizer = new model.KaldiRecognizer(captureRate); recognizer.setWords(true); const rec = recognizer; voskText = ''; waitingFinal = false;
  rec.on('partialresult', message => {
    if (recognizer !== rec || !isLive()) return;
    const text = message.result.partial || ''; if (text !== voskText) lastTextAt = Date.now(); voskText = text;
    if (enrollment) { showEnrollPartial(text); return; }
    $('heard-text').textContent = text || 'Слушаю…'; window.voiceKeys.recognize({ type: 'partial', text, epoch, segmentId });
  });
  rec.on('result', message => {
    if (recognizer !== rec && !finishing.includes(rec)) return;
    const text = message.result.text || ''; if (text && !enrollment) $('heard-text').textContent = text;
    if (enrollment) onEnrollText(text); else window.voiceKeys.recognize({ type: 'final', text, words: message.result.result || [], epoch, segmentId });
    if (finishing.includes(rec)) { finishing = finishing.filter(item => item !== rec); rec.remove(); return; }
    if (recognizer === rec) {
      recognizer = null; rec.remove(); const backlog = bufferedAudio; bufferedAudio = [];
      if (isLive()) { createVoskRecognizer(); for (const chunk of backlog) recognizer.acceptWaveformFloat(chunk, captureRate); }
    }
  });
}
function endListening(allowFinal) {
  diagnose('recognizer.finished', `epoch=${liveEpoch}; allowFinal=${allowFinal}`);
  if (config.modelId !== 'vosk') { if (allowFinal) window.voiceKeys.finishEngine({ epoch: liveEpoch }); else window.voiceKeys.stopEngine(); return; }
  if (!recognizer) return; const rec = recognizer; recognizer = null;
  if (allowFinal) { finishing.push(rec); rec.retrieveFinalResult(); finishTimer = setTimeout(() => { for (const item of finishing) item.remove(); finishing = []; }, 950); } else rec.remove();
}
async function listMicrophones(requestAccess = false) {
  if (refreshingMics) return; refreshingMics = true; updateControls(); let temporary;
  try {
    if (requestAccess && !stream?.active) temporary = await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices(); const activeTrack = (stream?.active ? stream : temporary)?.getAudioTracks()[0];
    const active = { id: activeTrack?.getSettings().deviceId, label: activeTrack?.label };
    const selectedId = $('microphone').value, savedLabel = $('microphone').selectedOptions[0]?.dataset.rawLabel || config.microphoneLabel;
    const list = microphoneOptions(devices, selectedId, savedLabel, active); $('microphone').replaceChildren();
    for (const device of list.options) { const item = option(device.id, device.label); item.title = device.label; item.dataset.rawLabel = device.rawLabel; item.dataset.missing = String(device.missing); $('microphone').append(item); }
    $('microphone').value = list.selectedId; $('microphone').title = $('microphone').selectedOptions[0]?.textContent || '';
    if (selectedId !== list.selectedId) { diagnose('microphone.resolved', `restored-by-name=${savedLabel}`); config.microphoneId = list.selectedId; }
    if (activeTrack) $('active-microphone').textContent = `Устройство: ${activeTrack.label}`;
    else if (list.options.slice(1).some(device => device.rawLabel)) $('active-microphone').textContent = 'Названия из Windows. ↻ — обновить устройства.';
    else $('active-microphone').textContent = 'Нажмите ↻, чтобы получить названия устройств.';
    diagnose('microphone.list', JSON.stringify(list.options.map(device => ({ label: device.label, missing: device.missing }))));
  } catch (error) { diagnose('microphone.list_failed', error.message); throw error; }
  finally { temporary?.getTracks().forEach(track => track.stop()); refreshingMics = false; updateControls(); }
}
function onMicrophoneEnded() { diagnose('microphone.ended'); ready = false; window.voiceKeys.ready(false); notice('Микрофон отключён. Подключите его и включите снова.'); updateControls(); }
// Recording shown on the button that started it: the button is replaced by "3 из 30", a level meter and a stop button; end() brings the button back.
// Any recording of the program uses it. A second line (note) tells what to say or why a take was refused.
let levelSink = null;
function inlineRecorder(button) {
  const box = document.createElement('span'); box.className = 'rec-inline'; box.setAttribute('role', 'status');
  const count = document.createElement('span'); count.className = 'rec-count';
  const meter = document.createElement('span'); meter.className = 'rec-meter'; const fill = document.createElement('i'); meter.append(fill); meter.title = 'Уровень микрофона';
  const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'rec-stop'; stop.textContent = '■'; stop.title = 'Остановить запись'; stop.setAttribute('aria-label', 'Остановить запись');
  const note = document.createElement('span'); note.className = 'rec-note';
  box.append(count, meter, stop, note); button.hidden = true; button.after(box);
  levelSink = percent => { fill.style.width = `${percent}%`; };
  return {
    setText: text => { count.textContent = text; },
    setNote: (text, kind = '') => { note.textContent = text; note.title = text; note.className = `rec-note ${kind}`; }, // the window has a fixed size: a long text is cut with an ellipsis, the whole text is in the tooltip
    onStop: handler => { stop.onclick = handler; },
    end: () => { levelSink = null; box.remove(); button.hidden = false; }
  };
}
window.inlineRecorder = inlineRecorder;
// One block of mono samples from whichever source is active (captureRate Hz).
function onAudioBlock(samples) {
  let sum = 0; for (const sample of samples) sum += sample * sample;
  const level = Math.min(100, Math.sqrt(sum / samples.length) * 430);
  $('meter-fill').style.width = $('enroll-meter').style.width = `${level}%`; levelSink?.(level);
  if (Math.sqrt(sum / samples.length) > 0.003) { const at = Date.now(); if (at - lastVoiceAt > 500) window.voiceKeys.voiceOnset(at); lastVoiceAt = at; }
  if (audioTap) audioTap(samples);
  if (!isLive()) return;
  if (config.classifierEnabled) window.voiceKeys.classifierAudio({ samples: samples.slice(), sampleRate: captureRate, epoch: liveEpoch });
  if (config.modelId !== 'vosk') {
    window.voiceKeys.audio({ samples: samples.slice(), sampleRate: captureRate, epoch: liveEpoch });
    if (lastVoiceAt > flushedVoiceAt && Date.now() - lastVoiceAt >= config.speechEndMs) { flushedVoiceAt = lastVoiceAt; window.voiceKeys.flushEngine({ epoch: liveEpoch }); }
    return;
  }
  if (recognizer) {
    if (waitingFinal) { bufferedAudio.push(samples.slice()); if (bufferedAudio.length > 32) bufferedAudio.shift(); }
    else {
      recognizer.acceptWaveformFloat(samples.slice(), captureRate);
      if (lastVoiceAt > flushedVoiceAt && Date.now() - lastVoiceAt >= config.speechEndMs && Date.now() - lastTextAt >= 50) { waitingFinal = true; flushedVoiceAt = lastVoiceAt; recognizer.retrieveFinalResult(); }
    }
  }
}
async function prepare() {
  if (!modelReady()) { $('model').closest('details')?.setAttribute('open', ''); $('model').scrollIntoView({ block: 'center' }); notice('Сначала скачайте модель распознавания: кнопка «Скачать» рядом с выбором модели.'); return false; }
  const captureAlive = () => config.captureMode === 'wasapi' ? Boolean(nativeCapture) : Boolean(stream?.active);
  if (ready && preparedLanguage === config.language && preparedMicrophone === config.microphoneId && preparedModel === config.modelId && preparedSpeechEnd === config.speechEndMs && preparedCapture === config.captureMode && captureAlive()) { await audio?.resume(); return true; }
  busy = true; ready = false; await window.voiceKeys.ready(false); updateControls(); notice('');
  try {
    $('listen-status').textContent = 'Подключаю микрофон…';
    const wantNative = config.captureMode === 'wasapi'; let fallbackNote = '';
    // The native helper has no device list of its own for the page: names come from Chromium, which needs a brief permission grant for them.
    await listMicrophones(wantNative);
    if ($('microphone').selectedOptions[0]?.dataset.missing === 'true') throw new Error('Выбранный микрофон недоступен. Обновите список и выберите устройство');
    stream?.getTracks().forEach(track => track.stop()); stream = null; if (audio) await audio.close(); audio = null;
    await window.voiceKeys.stopCapture(); nativeCapture = null;
    if (wantNative) {
      const label = $('microphone').selectedOptions[0]?.dataset.rawLabel || config.microphoneLabel || '';
      diagnose('microphone.requested', `wasapi:${label || 'system-default'}`);
      const started = await window.voiceKeys.startCapture(config.microphoneId ? label : '');
      if (started.ok) {
        nativeCapture = started; captureRate = started.rate;
        diagnose('microphone.ready', `wasapi:${started.device}; ${started.api}; ${started.rate} Hz; period ${started.periodMs} ms${started.matched || !config.microphoneId ? '' : '; device not matched, default used'}`);
        $('active-microphone').textContent = `Устройство: ${started.device} · WASAPI, ${started.periodMs} мс`;
      } else { diagnose('microphone.wasapi_failed', started.error); fallbackNote = `WASAPI не запустился, используется Chromium: ${started.error}`; }
    }
    if (!nativeCapture) {
      // Browser audio processing adds latency and can clip short consonants; commands need the raw signal.
      const constraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }; if (config.microphoneId) constraints.deviceId = { exact: config.microphoneId };
      diagnose('microphone.requested', config.microphoneId ? 'configured-device' : 'system-default'); stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      diagnose('microphone.ready', stream.getAudioTracks()[0]?.label || 'no-track-label'); await listMicrophones(false);
      if (fallbackNote) $('active-microphone').textContent += ` · ${fallbackNote}`;
    }
    $('listen-status').textContent = 'Загружаю модель распознавания…'; diagnose('model.loading', config.language);
    if (config.modelId !== 'vosk') {
      const result = await window.voiceKeys.prepareEngine(); if (!result.ok) throw new Error(result.error);
    } else if (!models.has(config.language)) {
      let timer; try { models.set(config.language, await Promise.race([Vosk.createModel(`${location.origin}/model-${config.language}.tar.gz`, 0), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Модель не подготовилась за 60 секунд. Перезапустите приложение и приложите лог')), 60000); })])); } finally { clearTimeout(timer); }
    }
    model = models.get(config.language); diagnose('model.ready', `${config.modelId}:${config.language}`);
    if (!nativeCapture) {
      audio = new AudioContext({ latencyHint: 'interactive' }); await audio.resume(); source = audio.createMediaStreamSource(stream); captureRate = audio.sampleRate;
      await audio.audioWorklet.addModule('/capture-worklet.js'); processor = new AudioWorkletNode(audio, 'capture-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      processor.port.onmessage = event => onAudioBlock(event.data);
      source.connect(processor); processor.connect(audio.destination);
      stream.getAudioTracks()[0].onended = onMicrophoneEnded;
    }
    preparedLanguage = config.language; preparedMicrophone = config.microphoneId; preparedModel = config.modelId; preparedSpeechEnd = config.speechEndMs; preparedCapture = config.captureMode; ready = true; await window.voiceKeys.ready(true); return true;
  } catch (error) { diagnose('voice.prepare_failed', `${error.message}\n${error.stack || ''}`); notice(`Не удалось подготовить распознавание: ${error.message}`); $('listen-status').textContent = 'Не удалось подготовить микрофон или модель.'; return false; }
  finally { busy = false; updateControls(); }
}
// quiet: an automatic save. It keeps what is on the screen as it is and reports problems in the line under the settings.
async function save({ quiet = false } = {}) {
  clearTimeout(autosaveTimer); autosaveTimer = null;
  if (!quiet) cancelCapture();
  const previousLanguage = config.language, previousMicrophone = config.microphoneId, sent = readForm();
  const result = await window.voiceKeys.save(sent);
  if (!result.ok) {
    if (quiet) { $('settings-note').textContent = `Не сохранено: ${result.error}`; $('settings-note').classList.add('bad'); return false; }
    notice(result.error); return false;
  }
  config = result.config;
  if (previousLanguage !== config.language || previousMicrophone !== config.microphoneId) { ready = false; await window.voiceKeys.ready(false); }
  const stamp = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('settings-note').classList.remove('bad');
  if (quiet) {
    // changed again while the save was in flight: keep waiting for the next one
    const changed = JSON.stringify(readForm()) !== JSON.stringify(sent);
    if (changed) { dirty = true; scheduleAutosave(300); $('settings-note').textContent = 'Сохраняю…'; }
    else { dirty = false; $('settings-note').textContent = `Сохранено автоматически в ${stamp}.`; }
    updateControls(); window.classifierRefresh?.(); return true;
  }
  dirty = false; $('settings-note').textContent = `Сохранено в ${stamp}. Настройки останутся после перезапуска.`; renderConfig(); applyState(currentState); notice(''); return true;
}
function confidenceLabel(value) { return Number.isFinite(value) ? ` · ${Math.round(value * 100)}%` : ''; }
const REASONS = { phrase_not_configured: 'Нет такой команды', confidence_too_low: 'Недостаточная уверенность', unknown_speech: 'Посторонняя речь', word_details_missing: 'Нет достоверной оценки слов', no_command_word: 'В тексте нет команды', duplicate_result: 'Повтор результата пропущен' };
const ASSIGNABLE = new Set(['phrase_not_configured', 'confidence_too_low', 'no_command_word', 'word_details_missing']);
function displayDecision(decision) {
  if (decision.reason === 'empty' || decision.reason === 'duplicate_result') return;
  const result = (REASONS[decision.reason] || 'Команда отклонена') + confidenceLabel(decision.confidence); $('decision-text').textContent = result; $('decision-text').className = 'rejected';
  historyEntries.unshift({ ...decision, phrase: decision.text, key: '—', result, kind: 'rejected', assignable: ASSIGNABLE.has(decision.reason) && Boolean(decision.text) && !/\[unk\]/.test(decision.text) }); historyEntries = historyEntries.slice(0, 50); renderHistory();
}
function displayAction(action) {
  displayedActionId = action.actionId;
  const label = action.label || action.key; $('last-key').textContent = label; $('last-key').classList.toggle('long', label.length > 4); $('last-phrase').textContent = `«${action.phrase}»`;
  const actionLabel = action.actionType === 'hold' ? `Удержание ${action.durationMs} мс` : action.actionType === 'toggle' ? (action.toggledOff ? 'Клавиша отпущена (переключатель)' : 'Клавиша зажата до повторной команды') : 'Короткое нажатие';
  const result = !action.ok ? action.reason : (action.mode === 'preview' ? 'Показано' : 'Нажата') + ` · ${actionLabel}` + (action.byClassifier ? ' · быстрый классификатор' : '');
  $('last-result').textContent = result + confidenceLabel(action.confidence); $('decision-text').textContent = (action.ok ? 'Команда принята' : 'Команда не выполнена') + confidenceLabel(action.confidence); $('decision-text').className = action.ok ? 'accepted' : 'rejected';
  $('key-stage').classList.remove('fired'); void $('key-stage').offsetWidth; $('key-stage').classList.add('fired');
  if (action.ok) playTone('press'); if (action.latency) showLatency(action.latency);
  for (const row of $('mappings').children) if (row.querySelector('.row-language').value === action.language && rowPhrases(row).some(item => normalize(item) === normalize(action.phrase))) { row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 700); }
  historyEntries.unshift({ ...action, result: result + confidenceLabel(action.confidence), kind: action.ok ? 'accepted' : 'error' }); historyEntries = historyEntries.slice(0, 50); renderHistory();
}
let historyStale = false;
function renderHistory(force = false) {
  if (!force && document.activeElement?.closest?.('#history .assign')) { historyStale = true; return; }
  historyStale = false; $('history').replaceChildren(); const shown = historyEntries.filter(item => $('show-rejected').checked || item.kind !== 'rejected'); $('history-count').textContent = shown.length;
  if (!shown.length) { const empty = document.createElement('p'); empty.className = 'empty-history'; empty.textContent = 'Здесь будут принятые и отклонённые команды.'; $('history').append(empty); return; }
  for (const item of shown) {
    const row = document.createElement('div'); row.className = `history-row ${item.kind}`;
    const time = document.createElement('time'); time.textContent = new Date(item.at).toLocaleTimeString('ru-RU');
    const phrase = document.createElement('span'); phrase.className = 'phrase'; phrase.textContent = item.phrase;
    const key = document.createElement('strong'); key.textContent = item.label || item.key;
    const result = document.createElement('span'); result.className = 'result'; result.textContent = item.result; row.append(time, phrase, key, result);
    if (item.assignable) row.append(assignControls(item));
    $('history').append(row);
  }
}
// Journal -> command: pick which command a misheard word belongs to; it is added as a learned variant right away.
function assignControls(entry) {
  const box = document.createElement('div'); box.className = 'assign';
  if (entry.assigned) { const done = document.createElement('span'); done.className = 'done'; done.textContent = `✓ Добавлено к команде ${entry.assigned}`; box.append(done); return box; }
  const targets = [...$('mappings').children].filter(row => row.querySelector('.row-language').value === config.language && rowPhrases(row).length);
  if (!targets.length) return document.createDocumentFragment();
  const words = [...new Set(entry.phrase.split(' ').filter(Boolean))];
  const wordMode = config.commandMode === 'words' && words.length > 1;
  entry.assignWord ??= wordMode ? '' : entry.phrase;
  if (wordMode) {
    const word = document.createElement('select'); word.setAttribute('aria-label', 'Какое слово назначить'); word.append(option('', 'Какое слово?'), ...words.map(item => option(item, `«${item}»`))); word.value = entry.assignWord;
    word.onchange = () => { entry.assignWord = word.value; }; box.append(word);
  } else { const label = document.createElement('span'); label.textContent = `«${entry.phrase}» это:`; box.append(label); }
  const target = document.createElement('select'); target.setAttribute('aria-label', 'Какой команде принадлежит слово');
  target.append(option('', 'Выберите команду…'), ...targets.map(row => {
    const mods = [...row.querySelectorAll('.mod[aria-pressed=true]')].map(chip => chip.dataset.mod);
    return option(row.dataset.id, `${actionLabel(row.querySelector('.row-key').value, mods)} · ${{ hold: 'удержать', toggle: 'переключить' }[row.querySelector('.row-action').value] || 'нажать'} · ${rowPhrases(row)[0] || rowNeural(row)[0] || ''}`);
  }));
  target.value = entry.assignRow || ''; target.onchange = () => { entry.assignRow = target.value; };
  const button = document.createElement('button'); button.className = 'small-button'; button.textContent = 'Назначить'; button.onclick = () => assignHeard(entry);
  box.append(target, button); return box;
}
async function assignHeard(entry) {
  const row = [...$('mappings').children].find(item => item.dataset.id === entry.assignRow), word = entry.assignWord;
  if (!row) { notice('Сначала выберите команду.'); return; }
  if (!word) { notice('Сначала выберите слово.'); return; }
  const language = row.querySelector('.row-language').value, wordKey = speechKey(word, language);
  for (const other of $('mappings').children) if (rowPhrases(other).some(item => speechKey(item, language) === wordKey)) {
    notice(other === row ? `«${word}» уже есть в этой команде.` : `«${word}» уже назначено другой команде: ${rowPhrases(other)[0]}.`); return;
  }
  const input = row.querySelector('.row-phrase'), before = { value: input.value, learned: row.dataset.learned };
  input.value = [...rowPhrases(row), word].join(', '); row.dataset.learned = JSON.stringify([...JSON.parse(row.dataset.learned || '[]'), word]);
  const mods = [...row.querySelectorAll('.mod[aria-pressed=true]')].map(chip => chip.dataset.mod), label = actionLabel(row.querySelector('.row-key').value, mods), id = row.dataset.id;
  if (!await saveLive()) { input.value = before.value; row.dataset.learned = before.learned; return; }
  entry.assigned = label; diagnose('journal.assigned', `${word} -> ${label}`); renderHistory(true);
  const saved = [...$('mappings').children].find(item => item.dataset.id === id); saved?.classList.add('flash'); setTimeout(() => saved?.classList.remove('flash'), 700);
  notice(`«${word}» теперь нажимает ${label}. Работает сразу.`, true);
}
// Saves the form without stopping the listener (used for variants added while listening).
async function saveLive() {
  cancelCapture(); const result = await window.voiceKeys.saveLive(readForm());
  if (!result.ok) { notice(result.error); return false; }
  config = result.config; dirty = false; renderConfig(); applyState(currentState); return true;
}
const latencyLog = [];
function showLatency(latency) {
  if (!Number.isFinite(latency.afterWordMs)) return;
  latencyLog.push(latency); if (latencyLog.length > 20) latencyLog.shift();
  const average = pick => { const values = latencyLog.map(pick).filter(Number.isFinite); return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null; };
  const lines = [`<span>После появления слова: <strong>${Math.round(latency.afterWordMs)} мс</strong> (ожидание ${Math.round(latency.stabilityMs)} + очередь ${Math.max(0, Math.round(latency.queueMs))})</span>`];
  if (Number.isFinite(latency.totalMs)) lines.push(`<span>От начала речи: <strong>${Math.round(latency.totalMs)} мс</strong>, из них до слова в тексте ${Math.round(latency.speechToTextMs)}</span>`);
  lines.push(`<span>Среднее за ${latencyLog.length}: ${average(item => item.afterWordMs)} мс${average(item => item.totalMs) === null ? '' : ` / от речи ${average(item => item.totalMs)} мс`}</span>`);
  $('latency').innerHTML = lines.join('<br>');
}
let toneContext, lastToneAt = 0;
function playTone(kind, force = false) {
  const sound = config?.sound; if (!sound || !force && (!sound.enabled || kind === 'match' && !sound.onMatch || kind === 'press' && !sound.onPress) || !sound.volume) return;
  const nowMs = performance.now(); if (!force && nowMs - lastToneAt < 25) return; lastToneAt = nowMs;
  try {
    toneContext ??= new AudioContext(); if (toneContext.state === 'suspended') toneContext.resume();
    const oscillator = toneContext.createOscillator(), gain = toneContext.createGain(), start = toneContext.currentTime, length = kind === 'match' ? 0.07 : 0.05;
    oscillator.type = 'sine'; oscillator.frequency.value = kind === 'match' ? 1175 : 660;
    gain.gain.setValueAtTime(0.0001, start); gain.gain.linearRampToValueAtTime(0.32 * (sound.volume / 100) ** 2 + 0.01, start + 0.005); gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
    oscillator.connect(gain).connect(toneContext.destination); oscillator.start(start); oscillator.stop(start + length + 0.02);
  } catch (error) { diagnose('ui.error', `tone: ${error.message}`); }
}
function renderPrefs() {
  const sound = config.sound || window.VoiceKeysCore.DEFAULTS.sound;
  $('sound-enabled').checked = sound.enabled; $('sound-match').checked = sound.onMatch; $('sound-press').checked = sound.onPress; $('sound-volume').value = sound.volume;
  $('theme').value = config.theme || 'system'; $('close-to-tray').checked = config.closeToTray !== false; applyTheme(config.theme || 'system');
  for (const id of ['sound-match', 'sound-press', 'sound-volume']) $(id).disabled = !sound.enabled;
}
async function savePrefs() {
  const prefs = { theme: $('theme').value, closeToTray: $('close-to-tray').checked, sound: { enabled: $('sound-enabled').checked, volume: Number($('sound-volume').value), onMatch: $('sound-match').checked, onPress: $('sound-press').checked } };
  Object.assign(config, prefs); renderPrefs();
  const result = await window.voiceKeys.setPrefs(prefs); if (!result.ok) notice(result.error || 'Не удалось сохранить параметры.');
}
async function adoptConfig(result) {
  cancelUtterance(); config = result.config; sampleList = result.samples || []; dirty = false; ready = false; await window.voiceKeys.ready(false);
  renderConfig(); renderSamples(); applyState(result.state); window.classifierRefresh?.();
}
// for the classifier panel: save pending edits, and show a changed config (words of a profile) without stopping the microphone
window.syncSettings = async () => (dirty ? await save() : true);
window.applyConfigQuiet = next => { config = next; renderConfig(); updateControls(); };
async function boot() {
  keyOptions($('hold-key'), 'F9', KEYBOARD_KEYS); const loaded = await window.voiceKeys.load(); config = loaded.config; installedModels = loaded.models || {}; renderConfig(); applyState(loaded.state); if (loaded.startupWarning) notice(loaded.startupWarning);
  window.voiceKeys.onMatched(() => playTone('match'));
  window.voiceKeys.onPrefs(value => { Object.assign(config, value); renderPrefs(); });
  window.voiceKeys.onCaptureAudio(samples => { if (nativeCapture) onAudioBlock(samples); });
  window.voiceKeys.onCaptureEnded(reason => { if (!nativeCapture) return; nativeCapture = null; diagnose('microphone.ended', `wasapi: ${reason}`); onMicrophoneEnded(); });
  window.voiceKeys.onConfigReplaced(async value => { if (busy || enrollment) return; await adoptConfig(value); notice(`Профиль: ${config.profiles.find(p => p.id === config.activeProfileId).name}`, true); });
  window.voiceKeys.onRequestStart(() => { if (!busy && !enrollment && !currentState?.armed) $('start').click(); });
  for (const id of ['sound-enabled', 'sound-match', 'sound-press', 'theme', 'close-to-tray']) $(id).onchange = savePrefs; $('sound-volume').onchange = savePrefs;
  $('sound-test').onclick = () => { playTone('match', true); setTimeout(() => playTone('press', true), 160); };
  $('profile-export').onclick = async () => { if (dirty && !await save()) return; const result = await window.voiceKeys.exportProfiles(); if (result.cancelled) return; notice(result.ok ? `Сохранено профилей: ${result.count}.` : result.error, Boolean(result.ok)); };
  $('net-badge').onclick = () => openClassifier();
  $('profile-import').onclick = async () => {
    if (busy || enrollment || dirty && !await save()) return; const result = await window.voiceKeys.importProfiles(); if (result.cancelled) return;
    if (!result.ok) { notice(result.error); return; } await adoptConfig(result); notice(`Добавлено профилей: ${result.added.length} (${result.added.join(', ')}). Текущий профиль не менялся.`, true);
  };
  $('history').addEventListener('focusout', () => { if (historyStale) setTimeout(() => renderHistory(), 0); });
  window.voiceKeys.onState(applyState); window.voiceKeys.onAction(displayAction); window.voiceKeys.onDecision(displayDecision); window.voiceKeys.onWarning(message => notice(message));
  window.voiceKeys.onTranscript(value => { if (value.epoch !== liveEpoch) return; if (enrollment) { if (value.type === 'final') onEnrollText(value.text); else showEnrollPartial(value.text); return; } if (value.text) $('heard-text').textContent = value.text; });
  window.voiceKeys.onInputState(actions => { $('active-keys').replaceChildren(); for (const action of actions) { const item = document.createElement('span'); item.textContent = `${action.label || action.key} · ${action.actionType === 'hold' ? action.durationMs + ' мс' : action.actionType === 'toggle' ? 'зажата' : 'нажата'}`; $('active-keys').append(item); } });
  window.voiceKeys.onReleased(value => { const entry = historyEntries.find(item => item.actionId === value.actionId); if (entry) { entry.result += value.cancelled ? ' · отменено' : entry.actionType==='hold'?` · отпущена через ${Math.round(value.actualDurationMs)} мс`:entry.actionType==='toggle'?(value.manual?' · отпущена вами':' · отпущена'):''; if (displayedActionId === value.actionId) $('last-result').textContent = entry.result; renderHistory(); } });
  window.voiceKeys.onQueue(items=>{$('pending-keys').replaceChildren();const pending=items.filter(item=>item.status==='pending');if(pending.length){const label=document.createElement('span');label.textContent=`Очередь: ${pending.map(item=>item.label||item.key).join(' → ')}`;$('pending-keys').append(label);}});
  window.voiceKeys.onModelProgress(message => { $('recognition-hint').textContent = message; });
  $('enroll-cancel').onclick = () => $('enroll-dialog').close(); $('enroll-retry').onclick = beginEnrollCapture; $('enroll-apply').onclick = applyEnrollment; $('enroll-dialog').addEventListener('close', endEnrollment);
  $('add').onclick = () => { const input = addRow(); input.focus(); input.scrollIntoView({ block: 'nearest' }); markDirty(); }; $('save').onclick = $('save-settings').onclick = save;
  $('show-rejected').onchange = renderHistory; $('language').onchange = () => { if ($('language').value === 'en' && $('model').value !== 'vosk') $('model').value = 'vosk'; updateRows(); markDirty(); };
  $('listen-mode').onchange = markDirty; $('hold-key').onchange = markDirty; $('confidence').onchange = markDirty;
  $('model').onchange = markDirty; $('capture-mode').onchange = markDirty; $('classifier-enabled').onchange = markDirty; $('command-mode').onchange = () => { updateRows(); markDirty(); }; $('word-stability').oninput = markDirty; $('prefix-match').onchange = markDirty; $('speech-end').oninput = markDirty;
  for(const element of document.querySelectorAll('.overlay-settings input,.overlay-settings select'))element.onchange=markDirty;
  $('overlay-demo').onclick=async()=>{if(dirty&&!await save())return;await window.voiceKeys.overlayDemo();};
  $('profile-select').onchange=()=>performProfile({operation:'switch',id:$('profile-select').value});
  for(const [id,operation] of [['profile-new','create'],['profile-duplicate','duplicate'],['profile-rename','rename'],['profile-delete','delete']])$(id).onclick=()=>openProfileDialog(operation);
  $('profile-dialog').addEventListener('close',()=>{if($('profile-dialog').returnValue==='ok')performProfile({operation:profileOperation,id:profileTarget,name:$('profile-name').value,copy:$('profile-copy').checked});});
  sampleList=loaded.samples||[];renderSamples();$('sample-record').onclick=()=>startSampleRecording();$('sample-play').onclick=playSample;$('sample-test').onclick=benchmarkSample;$('sample-delete').onclick=async()=>{const result=await window.voiceKeys.deleteSample($('sample-select').value);if(result.ok){sampleList=result.samples;renderSamples();}else notice(result.error||'Не удалось удалить запись.');};
  $('model-banner-install').onclick = () => installModel(neededModel());
  $('microphone').onchange = () => { $('microphone').title = $('microphone').selectedOptions[0]?.textContent || ''; markDirty(); };
  $('refresh-mics').onclick = () => listMicrophones(true).catch(error => notice(`Не удалось обновить микрофоны: ${error.message}`));
  navigator.mediaDevices.addEventListener('devicechange', () => { if (!currentState?.armed && !busy) listMicrophones(false).catch(error => notice(error.message)); });
  for (const [id, mode] of [['mode-preview', 'preview'], ['mode-keyboard', 'keyboard']]) $(id).onclick = () => { config.outputMode = mode; updateMode(); markDirty(); };
  $('start').onclick = async () => { if (busy) return; if (dirty && !await save()) return; if (!await prepare()) return; const result = await window.voiceKeys.arm(true); if (!result.ok) notice(result.error || 'Не удалось включить прослушивание.'); else { notice(''); applyState(result.state); } };
  $('stop').onclick = () => window.voiceKeys.arm(false); $('clear-history').onclick = () => { historyEntries = []; renderHistory(); };
  $('log-location').textContent = loaded.logs?.error ? `Ошибка журнала: ${loaded.logs.error}` : 'Команды и скорость — в логе. Аудио сохраняется только кнопкой «Записать».'; $('log-location').title = loaded.logs?.directory || '';
  $('open-logs').onclick = async () => { const result = await window.voiceKeys.openLogs(); if (!result.ok) notice(`Не удалось открыть логи: ${result.error}`); };
  $('test-pad').onkeydown = event => { if (!event.repeat) diagnose('test.keydown', event.code); $('physical-note').textContent = `Получено: ${event.code} · ${new Date().toLocaleTimeString('ru-RU')}`; };
  diagnose('ui.ready'); listMicrophones(false).catch(error => notice(`Список микрофонов недоступен: ${error.message}`));
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAutosave(); });
window.addEventListener('pagehide', flushAutosave);
window.addEventListener('beforeunload', () => { stream?.getTracks().forEach(track => track.stop()); window.voiceKeys.stopCapture(); });
boot().catch(error => notice(`Ошибка интерфейса: ${error.message}`));

function renderProfiles(){
  $('profile-select').replaceChildren();for(const profile of config.profiles||[{id:'profile-default',name:'Общий'}])$('profile-select').append(option(profile.id,profile.name));$('profile-select').value=config.activeProfileId||'profile-default';
  syncProfileButtons();
}
// the general profile is always there: it cannot be renamed or deleted
function syncProfileButtons(){const general=config?.activeProfileId==='profile-default';$('profile-rename').disabled=general;$('profile-delete').disabled=general;$('profile-rename').title=general?'Общий профиль нельзя переименовать':'Переименовать профиль';$('profile-delete').title=general?'Общий профиль нельзя удалить':'Удалить профиль';}
function openProfileDialog(operation,targetId=config.activeProfileId){
  profileOperation=operation;profileTarget=targetId;const current=config.profiles.find(profile=>profile.id===targetId);
  if(current?.id==='profile-default'&&(operation==='rename'||operation==='delete')){notice('Общий профиль нельзя переименовать или удалить.');return;}
  const naming=operation==='create'||operation==='duplicate';
  $('profile-dialog-title').textContent=operation==='create'?'Новый профиль':operation==='duplicate'?`Дублировать «${current.name}»`:operation==='rename'?'Переименовать профиль':`Удалить «${current.name}»?`;
  $('profile-name-label').hidden=operation==='delete';$('profile-name').required=operation!=='delete';$('profile-name').value=operation==='create'?'':operation==='duplicate'?`${current.name} (копия)`.slice(0,40):current.name;
  $('profile-copy-label').hidden=operation!=='create';$('profile-copy').checked=false;$('profile-delete-note').classList.toggle('hidden',operation!=='delete');
  $('profile-confirm').textContent=naming?(operation==='create'?'Создать':'Дублировать'):operation==='rename'?'Сохранить':'Удалить';$('profile-dialog').showModal();if(operation!=='delete')$('profile-name').focus();
}

async function performProfile(value){
  if(busy)return;if(dirty&&!await save()){renderProfiles();return;}
  const result=await window.voiceKeys.profile(value);if(!result.ok){notice(result.error);renderProfiles();return;}
  await adoptConfig(result);notice(`Профиль: ${config.profiles.find(p=>p.id===config.activeProfileId).name}`,true);
}
function renderSamples(){
  const selected=$('sample-select').value;$('sample-select').replaceChildren();
  for(const sample of sampleList)$('sample-select').append(option(sample.id,`${sample.expectedText} · ${(sample.durationMs/1000).toFixed(1)} с · ${new Date(sample.createdAt).toLocaleTimeString('ru-RU')}`));
  if(sampleList.some(sample=>sample.id===selected))$('sample-select').value=selected;
  if(!sampleList.length)$('sample-select').append(option('','Пока нет записей'));
  updateControls();
}
async function startSampleRecording(){
  if(busy||currentState?.armed)return;if(dirty&&!await save())return;
  if(!$('sample-text').value.trim()){notice('Напишите, что произнесёте в записи.');$('sample-text').focus();return;}
  busy=true;updateControls();let captureStream,context;
  try{
    captureStream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,...(config.microphoneId?{deviceId:{exact:config.microphoneId}}:{})}});
    context=new AudioContext();await context.resume();const source=context.createMediaStreamSource(captureStream),capture=context.createScriptProcessor(1024,1,1),chunks=[];
    const widget=inlineRecorder($('sample-record')),startedAt=Date.now();widget.onStop(stopSampleRecording);widget.setText('0 из 8 с');widget.setNote('Произнесите слова');
    capture.onaudioprocess=event=>{const block=event.inputBuffer.getChannelData(0);chunks.push(block.slice());let sum=0;for(const value of block)sum+=value*value;levelSink?.(Math.min(100,Math.sqrt(sum/block.length)*430));widget.setText(`${Math.min(8,Math.floor((Date.now()-startedAt)/1000))} из 8 с`);};source.connect(capture);capture.connect(context.destination);
    sampleRecorder={captureStream,context,source,capture,chunks,widget,expectedText:$('sample-text').value.trim(),timer:setTimeout(stopSampleRecording,8000)};
    $('sample-result').textContent='Идёт запись, до 8 секунд.';updateControls();
  }catch(error){captureStream?.getTracks().forEach(track=>track.stop());await context?.close();busy=false;updateControls();notice(`Не удалось записать: ${error.message}`);}
}
async function stopSampleRecording(){
  const record=sampleRecorder;if(!record)return;sampleRecorder=null;clearTimeout(record.timer);record.capture.disconnect();record.source.disconnect();record.captureStream.getTracks().forEach(track=>track.stop());
  try{
    const pcm=new Float32Array(record.chunks.reduce((sum,chunk)=>sum+chunk.length,0));let at=0;for(const chunk of record.chunks){pcm.set(chunk,at);at+=chunk.length;}
    const result=await window.voiceKeys.saveSample({expectedText:record.expectedText,samples:pcm,sampleRate:record.context.sampleRate});
    if(!result.ok)throw new Error(result.error);sampleList=result.samples;$('sample-result').textContent=`Записано ${(result.sample.durationMs/1000).toFixed(1)} с. Теперь можно прослушать и замерить.`;renderSamples();
  }catch(error){notice(error.message);}finally{record.widget.end();await record.context.close();busy=false;updateControls();}
}
async function playSample(){
  try{const sample=await window.voiceKeys.readSample($('sample-select').value),context=new AudioContext();await context.resume();const buffer=context.createBuffer(1,sample.samples.length,sample.sampleRate);buffer.getChannelData(0).set(sample.samples);const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);source.onended=()=>context.close();source.start();}catch(error){notice(error.message);}
}
async function getVoskModel(language){
  if(!models.has(language)){let timer;try{models.set(language,await Promise.race([Vosk.createModel(`${location.origin}/model-${language}.tar.gz`,0),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Модель не подготовилась за 60 секунд.')),60000);})]));}finally{clearTimeout(timer);}}
  return models.get(language);
}
async function benchmarkSample(){
  if(busy||currentState?.armed)return;if(dirty&&!await save())return;const id=$('sample-select').value;if(!id)return;
  busy=true;updateControls();$('sample-result').textContent='Обрабатываю запись выбранной моделью. Нажатия выключены…';
  try{
    const sample=await window.voiceKeys.readSample(id);const loadStarted=performance.now();let result,loadMs;
    if(config.modelId!=='vosk'){
      const prepared=await window.voiceKeys.prepareEngine();if(!prepared.ok)throw new Error(prepared.error);loadMs=performance.now()-loadStarted;
      const started=performance.now();result=await window.voiceKeys.benchmarkSample(id);if(!result.ok)throw new Error(result.error);result.engineDecodeMs=result.decodeMs;result.decodeMs=performance.now()-started;result.firstTextMs=result.decodeMs;
    }else{
      const testModel=await getVoskModel(config.language);loadMs=performance.now()-loadStarted;
      result=await new Promise((resolve,reject)=>{
        const rec=new testModel.KaldiRecognizer(sample.sampleRate),started=performance.now();let firstTextMs=null,finalRequested=false,finished=false;
        const timeout=setTimeout(()=>finish(new Error('Замер не завершился за 30 секунд.')),30000);
        function finish(error,value){if(finished)return;finished=true;clearTimeout(timeout);rec.remove();if(error)reject(error);else resolve(value);}
        rec.on('partialresult',message=>{if(message.result.partial&&firstTextMs===null)firstTextMs=performance.now()-started;if(!finalRequested){finalRequested=true;rec.retrieveFinalResult();}});
        rec.on('result',message=>finish(null,{recognizedText:message.result.text||'',decodeMs:performance.now()-started,firstTextMs:firstTextMs??performance.now()-started}));
        const pcm=new Float32Array(sample.samples.length+Math.round(sample.sampleRate*.8));pcm.set(sample.samples);rec.acceptWaveformFloat(pcm,sample.sampleRate);
      });
    }
    const report=await window.voiceKeys.reportSample({id,...result,loadMs});const matched=normalize(report.recognizedText)===normalize(sample.expectedText);
    $('sample-result').textContent=`${matched?'Совпало':'Текст отличается'}: «${report.recognizedText||'пусто'}». Обработка ${Math.round(report.decodeMs)} мс / запись ${report.audioMs} мс; RTF ${report.realTimeFactor.toFixed(3)}. Подготовка модели ${Math.round(loadMs)} мс отдельно. Это обработка готовой записи, не задержка живой команды. Результат сохранён в лог.`;
  }catch(error){notice(error.message);$('sample-result').textContent=`Замер не выполнен: ${error.message}`;}finally{busy=false;updateControls();}
}



// Voice enrollment: say a word three times, keep whatever the model heard as extra spellings of that command.
function enrollNote(text) { $('enroll-note').textContent = text; }
function showEnrollPartial(text) { if (enrollment && !enrollment.done) $('enroll-partial').textContent = text ? `«${text}»` : '…'; }
function renderEnroll() {
  const { heard, done } = enrollment, step = Math.min(heard.length, ENROLL_REPEATS - 1);
  $('enroll-prompt').textContent = done ? 'Готово. Вот что услышала модель:' : `Скажите слово — ${ORDINALS[step]} раз`;
  $('enroll-dots').replaceChildren(...Array.from({ length: ENROLL_REPEATS }, (_, index) => {
    const dot = document.createElement('span'); dot.className = index < heard.length ? 'step done' : index === heard.length ? 'step current' : 'step';
    dot.textContent = index < heard.length ? `«${heard[index]}»` : String(index + 1); return dot;
  }));
  $('enroll-partial').hidden = done; if (!done) $('enroll-partial').textContent = '…';
}
function enrollPlan() {
  const { row, heard } = enrollment, language = row.querySelector('.row-language').value, own = new Set(rowPhrases(row).map(item => speechKey(item, language)));
  const taken = new Map();
  for (const other of $('mappings').children) if (other !== row && other.querySelector('.row-language').value === language) for (const item of rowPhrases(other)) taken.set(speechKey(item, language), other.querySelector('.row-key').value);
  const add = [], skipped = [];
  for (const item of heard) {
    const key = speechKey(item, language);
    if (own.has(key) || add.some(entry => speechKey(entry, language) === key)) continue;
    if (taken.has(key)) skipped.push(`«${item}» уже назначено на ${taken.get(key)}`); else add.push(item);
  }
  return { add, skipped };
}
function beginEnrollCapture() {
  enrollment.heard = []; enrollment.done = false; cancelUtterance(); segmentCounter = 0; lastVoiceAt = 0; flushedVoiceAt = 0;
  if (config.modelId !== 'vosk') window.voiceKeys.startEngine({ epoch: liveEpoch }); else createVoskRecognizer();
  $('enroll-retry').classList.add('hidden'); $('enroll-apply').classList.add('hidden');
  enrollNote('Говорите одно слово и делайте короткую паузу. Если модель ошибётся — это нормально: ошибка тоже пригодится.'); renderEnroll(); updateControls();
}
function onEnrollText(text) {
  if (!enrollment || enrollment.done) return;
  const value = cleanPhrase(text); if (!value) return;
  const letters = /[а-яё]/.test(value) ? 'ru' : /[a-z]/.test(value) ? 'en' : null;
  if (/\[unk\]/i.test(text) || letters !== enrollment.row.querySelector('.row-language').value || /[a-z]/.test(value) && /[а-яё]/.test(value) || value.length > 80) {
    enrollNote('Не удалось разобрать слово. Повторите ещё раз.'); return;
  }
  enrollment.heard.push(value); diagnose('enroll.heard', value);
  if (enrollment.heard.length < ENROLL_REPEATS) { enrollNote(`Услышано: «${value}». Продолжаем.`); renderEnroll(); return; }
  enrollment.done = true; cancelUtterance(); renderEnroll();
  const plan = enrollPlan();
  $('enroll-retry').classList.remove('hidden'); $('enroll-apply').classList.toggle('hidden', !plan.add.length);
  $('enroll-apply').textContent = plan.add.length === 1 ? 'Добавить 1 вариант' : `Добавить ${plan.add.length}`;
  enrollNote(plan.add.length ? `Будет добавлено: ${plan.add.map(item => `«${item}»`).join(', ')}.${plan.skipped.length ? ` Пропущено: ${plan.skipped.join('; ')}.` : ''}` : plan.skipped.length ? `Всё услышанное уже занято: ${plan.skipped.join('; ')}.` : 'Все три слова уже есть в списке этой строки.');
}
async function startEnrollment(row) {
  if (busy || enrollment || currentState?.armed) return;
  cancelCapture(); const form = readForm(), language = row.querySelector('.row-language').value;
  if (dirty && !await save()) return;
  if (['language', 'modelId', 'microphoneId', 'speechEndMs'].some(name => form[name] !== config[name])) { notice('Настройки ещё не применились: подождите секунду и повторите.'); return; }
  if (language !== config.language) { notice(language === 'ru' ? 'Выберите русский язык распознавания и сохраните.' : 'Выберите English в языке распознавания и сохраните.'); return; }
  if (!await prepare()) return;
  const started = await window.voiceKeys.enrollStart(); if (!started.ok) { notice(started.error); return; }
  notice(''); liveEpoch = started.epoch; enrollment = { row, heard: [], done: false };
  const key = row.querySelector('.row-key').value, current = rowPhrases(row);
  $('enroll-target').textContent = `Клавиша ${key}${current.length ? ` · сейчас: ${current.join(', ')}` : ''}`;
  $('enroll-dialog').showModal(); beginEnrollCapture();
}
function applyEnrollment() {
  if (!enrollment?.done) return;
  const { row } = enrollment, plan = enrollPlan(), input = row.querySelector('.row-phrase');
  const learned = new Set(JSON.parse(row.dataset.learned || '[]')); for (const item of plan.add) learned.add(item);
  input.value = [...rowPhrases(row), ...plan.add].join(', '); row.dataset.learned = JSON.stringify([...learned]);
  updateRows(); markDirty(); notice(`Добавлено: ${plan.add.join(', ')}.`, true);
  row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 700);
  $('enroll-dialog').close();
}
async function endEnrollment() {
  if (!enrollment) return;
  enrollment = null; cancelUtterance(); await window.voiceKeys.enrollStop(); updateControls();
}
