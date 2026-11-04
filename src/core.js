'use strict';

// Shared by the main process and the isolated renderer. No OS access here.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VoiceKeysCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Milliseconds like Date.now(), but driven by the monotonic counter: a system clock change (time sync, DST, manual) must not
  // stretch the pauses and expiry times that the key queue, the matcher and the dedupe window measure.
  const monotonicNow = (() => { const origin = Date.now() - performance.now(); return () => origin + performance.now(); })();
  const KEYBOARD_KEYS = [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'0123456789',
    ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
    'SPACE', 'TAB', 'ENTER', 'ESCAPE', 'BACKSPACE', 'DELETE', 'INSERT',
    'HOME', 'END', 'PAGEUP', 'PAGEDOWN', 'UP', 'DOWN', 'LEFT', 'RIGHT',
    ...Array.from({ length: 10 }, (_, i) => `NUM${i}`),
    'NUMADD', 'NUMSUBTRACT', 'NUMMULTIPLY', 'NUMDIVIDE', 'NUMDECIMAL',
    '-', '=', '[', ']', ';', "'", ',', '.', '/', '\\', '`'
  ];
  // Mouse buttons and wheel notches are assignable like keys; the wheel has no "hold".
  const MOUSE_KEYS = ['MOUSE_LEFT', 'MOUSE_RIGHT', 'MOUSE_MIDDLE', 'MOUSE_X1', 'MOUSE_X2', 'WHEEL_UP', 'WHEEL_DOWN', 'WHEEL_LEFT', 'WHEEL_RIGHT'];
  const KEYS = [...KEYBOARD_KEYS, ...MOUSE_KEYS];
  const MODIFIERS = ['CTRL', 'SHIFT', 'ALT'];
  const KEY_LABELS = {
    MOUSE_LEFT: 'ЛКМ', MOUSE_RIGHT: 'ПКМ', MOUSE_MIDDLE: 'СКМ', MOUSE_X1: 'Мышь 4', MOUSE_X2: 'Мышь 5',
    WHEEL_UP: 'Колесо ↑', WHEEL_DOWN: 'Колесо ↓', WHEEL_LEFT: 'Колесо ←', WHEEL_RIGHT: 'Колесо →'
  };
  const KEY_DESCRIPTIONS = {
    MOUSE_LEFT: 'Мышь · левая кнопка', MOUSE_RIGHT: 'Мышь · правая кнопка', MOUSE_MIDDLE: 'Мышь · средняя кнопка',
    MOUSE_X1: 'Мышь · боковая 1 (назад)', MOUSE_X2: 'Мышь · боковая 2 (вперёд)',
    WHEEL_UP: 'Колесо вверх', WHEEL_DOWN: 'Колесо вниз', WHEEL_LEFT: 'Колесо влево', WHEEL_RIGHT: 'Колесо вправо'
  };
  const MODIFIER_LABELS = { CTRL: 'Ctrl', SHIFT: 'Shift', ALT: 'Alt' };
  const isWheel = key => typeof key === 'string' && key.startsWith('WHEEL_');
  function canonicalModifiers(list) {
    const wanted = new Set(Array.isArray(list) ? list : []);
    return MODIFIERS.filter(name => wanted.has(name));
  }
  function keyLabel(key) { return KEY_LABELS[key] || key; }
  function actionLabel(key, modifiers) { return [...canonicalModifiers(modifiers).map(name => MODIFIER_LABELS[name]), keyLabel(key)].join('+'); }
  const DEFAULTS = {
    version: 1, language: 'ru', listenMode: 'always', holdKey: 'F9', microphoneId: '',
    microphoneLabel: '', outputMode: 'preview', keyDurationMs: 65, confidenceThreshold: 0.85,
    commandMode: 'words', modelId: 'gigaam', captureMode: 'chromium', classifierEnabled: true, wordStabilityMs: 0, prefixMatch: true, speechEndMs: 250, queueGapMs: 80,
    overlay: { enabled: true, orientation: 'horizontal', anchor: 'top', offsetX: 0, offsetY: 100, size: 44, retentionMs: 2500 },
    sound: { enabled: true, volume: 40, onMatch: true, onPress: true }, theme: 'system', closeToTray: true,
    mappings: [
      { id: 'ru-q', phrase: 'первый', key: 'Q', language: 'ru' },
      { id: 'ru-w', phrase: 'второй', key: 'W', language: 'ru' },
      { id: 'ru-e', phrase: 'третий', key: 'E', language: 'ru' },
      { id: 'ru-r', phrase: 'четвёртый', key: 'R', language: 'ru' },
      { id: 'en-q', phrase: 'queue', key: 'Q', language: 'en' },
      { id: 'en-w', phrase: 'double you', key: 'W', language: 'en' },
      { id: 'en-e', phrase: 'echo', key: 'E', language: 'en' },
      { id: 'en-r', phrase: 'radio', key: 'R', language: 'en' }
    ]
  };

  function normalize(text) {
    return String(text || '').toLowerCase().replace(/ё/g, 'е')
      .replace(/[^a-zа-я0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function cleanPhrase(text) {
    return String(text || '').toLowerCase().replace(/[^a-zа-яё0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // One mapping may list several spoken variants for the same key: ["ку", "кью", "pew"].
  const MAX_PHRASES = 30;
  // A word of the personal classifier's library: lower case, no spaces, "ё" is "е" (same rule as classifier/store.js).
  const libraryWord = text => String(text ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9-]/g, '').slice(0, 30);
  // Words of the neural network of one command, separate from the text phrases that the recognizer is asked for.
  const trainedList = mapping => [...new Set((Array.isArray(mapping.trainedWords) ? mapping.trainedWords : []).map(libraryWord).filter(Boolean))].slice(0, MAX_PHRASES);
  // Letters of an unfinished word needed before a command may fire by its start ("Срабатывание по началу слова").
  const PREFIX_LETTERS = 3;
  function phraseList(mapping) {
    const source = Array.isArray(mapping.phrases) ? mapping.phrases : [mapping.phrase];
    return source.flatMap(item => String(item ?? '').split(/[,;\n]/)).map(item => item.trim()).filter(Boolean);
  }
  // [speechKey, command] pairs: every variant of every mapping in one language.
  function expandMappings(mappings, language) {
    const entries = [];
    for (const mapping of mappings) {
      if (mapping.language !== language) continue;
      const learned = new Set((mapping.learned || []).map(cleanPhrase));
      for (const phrase of phraseList(mapping)) entries.push([speechKey(phrase, language), { ...mapping, phrase, learned: learned.has(cleanPhrase(phrase)) }]);
    }
    return entries;
  }
  function speechKey(text, language) {
    const value = normalize(text);
    // The English decoder can spell a spoken letter as either a letter or its name.
    // These are exact whole-utterance equivalents, never substring replacements.
    if (language === 'en') return ({ queue: 'q', q: 'q', 'double you': 'w', w: 'w', are: 'r', r: 'r' })[value] || value;
    return value;
  }

  // requireLanguage: the active config must have a command in the chosen language; stored or switched-to profiles may not.
  function validateConfig(input, { requireLanguage = true } = {}) {
    if (!input || typeof input !== 'object') throw new Error('Настройки должны быть объектом.');
    if (!['ru', 'en'].includes(input.language)) throw new Error('Выберите язык: русский или English.');
    if (!['hold', 'always'].includes(input.listenMode)) throw new Error('Неизвестный режим прослушивания.');
    if (!KEYBOARD_KEYS.includes(input.holdKey)) throw new Error('Выберите одну клавишу клавиатуры для прослушивания.');
    if (!['preview', 'keyboard'].includes(input.outputMode)) throw new Error('Неизвестный режим вывода.');
    const commandMode = input.commandMode ?? 'phrase';
    const modelId = input.modelId ?? 'vosk';
    if (!['phrase', 'words'].includes(commandMode)) throw new Error('Выберите слова или целую фразу.');
    if (!['vosk', 'sherpa', 'gigaam'].includes(modelId)) throw new Error('Неизвестная модель.');
    if (modelId !== 'vosk' && input.language !== 'ru') throw new Error('T-one и GigaAM поддерживают русский язык; для English выберите Vosk.');
    if (!Array.isArray(input.mappings) || input.mappings.length > 100) {
      throw new Error('Допустимо до 100 назначений.');
    }
    const seen = new Set();
    const mappings = input.mappings.map((mapping, index) => {
      const list = phraseList(mapping), trainedWords = trainedList(mapping);
      if (!list.length && !trainedWords.length) throw new Error(`Строка ${index + 1}: нужна фраза от 1 до 80 символов или слово нейросети.`);
      if (list.length > MAX_PHRASES) throw new Error(`Строка ${index + 1}: допустимо до ${MAX_PHRASES} вариантов слова.`);
      if (!['ru', 'en'].includes(mapping.language)) throw new Error(`Строка ${index + 1}: выберите язык.`);
      if (!KEYS.includes(mapping.key)) throw new Error(`Строка ${index + 1}: выберите одну клавишу без сочетаний.`);
      if (input.listenMode === 'hold' && mapping.key === input.holdKey) {
        throw new Error(`Строка ${index + 1}: клавиша команды совпадает с клавишей прослушивания.`);
      }
      if (mapping.modifiers !== undefined && (!Array.isArray(mapping.modifiers) || mapping.modifiers.some(name => !MODIFIERS.includes(name)))) {
        throw new Error(`Строка ${index + 1}: модификаторы — только Ctrl, Shift и Alt.`);
      }
      const modifiers = canonicalModifiers(mapping.modifiers);
      const own = new Set(), phrases = [];
      for (const raw of list) {
        const phrase = cleanPhrase(raw);
        if (!phrase || phrase.length > 80) throw new Error(`Строка ${index + 1}: нужна фраза от 1 до 80 символов.`);
        const phraseLanguage = /[а-яё]/.test(phrase) ? 'ru' : /[a-z]/.test(phrase) ? 'en' : null;
        if (!phraseLanguage || phraseLanguage !== mapping.language || /[a-z]/.test(phrase) && /[а-яё]/.test(phrase)) {
          throw new Error(`Строка ${index + 1}: напишите фразу «${phrase}» буквами выбранного языка; цифры лучше писать словами.`);
        }
        const identity = `${mapping.language}:${speechKey(phrase, mapping.language)}`;
        if (own.has(identity)) continue;
        if (seen.has(identity)) throw new Error(`Фраза «${phrase}» повторяется для одного языка.`);
        own.add(identity); phrases.push(phrase);
      }
      for (const identity of own) seen.add(identity);
      const learnedSet = new Set((Array.isArray(mapping.learned) ? mapping.learned : []).map(item => cleanPhrase(String(item))));
      const learned = phrases.filter(phrase => learnedSet.has(phrase));
      if (!['tap', 'hold', 'toggle'].includes(mapping.actionType ?? 'tap')) throw new Error(`Строка ${index + 1}: выберите нажатие, удержание или переключение.`);
      const actionType = isWheel(mapping.key) ? 'tap' : mapping.actionType ?? 'tap';
      const durationMs = actionType === 'hold' ? Number(mapping.durationMs ?? 1000) : 65;
      if (!Number.isInteger(durationMs) || durationMs < 20 || durationMs > 10000) throw new Error(`Строка ${index + 1}: удержание должно быть от 20 до 10000 мс.`);
      return { id: /^[a-zA-Z0-9-]{1,80}$/.test(mapping.id) ? mapping.id : `mapping-${index}`, phrase: phrases[0] ?? trainedWords[0], phrases, trainedWords, learned, language: mapping.language, key: mapping.key, modifiers, actionType, durationMs };
    });
    if (requireLanguage && mappings.length && !mappings.some(mapping => mapping.language === input.language)) {
      throw new Error('Добавьте хотя бы одну фразу для выбранного языка распознавания.');
    }
    return {
      version: 1, language: input.language, listenMode: input.listenMode, holdKey: input.holdKey,
      microphoneId: typeof input.microphoneId === 'string' ? input.microphoneId.slice(0, 300) : '',
      microphoneLabel: typeof input.microphoneLabel === 'string' ? input.microphoneLabel.slice(0, 300) : '',
      confidenceThreshold: [0.75, 0.85, 0.95].includes(input.confidenceThreshold) ? input.confidenceThreshold : 0.85,
      commandMode, modelId, captureMode: input.captureMode === 'wasapi' ? 'wasapi' : 'chromium', classifierEnabled: input.classifierEnabled !== false,
      wordStabilityMs: Number.isInteger(input.wordStabilityMs) && input.wordStabilityMs >= 0 && input.wordStabilityMs <= 500 ? input.wordStabilityMs : 100,
      prefixMatch: input.prefixMatch !== false,
      speechEndMs: Number.isInteger(input.speechEndMs) && input.speechEndMs >= 120 && input.speechEndMs <= 1500 ? input.speechEndMs : 250,
      queueGapMs: bounded(input.queueGapMs, 20, 1000, 80),
      overlay: validateOverlay(input.overlay), sound: validateSound(input.sound), theme: ['system', 'light', 'dark'].includes(input.theme) ? input.theme : 'system',
      closeToTray: input.closeToTray !== false, outputMode: input.outputMode, keyDurationMs: 65, mappings,
      // the words of the neural network of the profile: the ones chosen in the classifier plus every word used by a command
      neuralWords: [...new Set([...(Array.isArray(input.neuralWords) ? input.neuralWords : []).map(libraryWord).filter(Boolean), ...mappings.flatMap(mapping => mapping.trainedWords)])].slice(0, 100)
    };
  }

  // An entire recognized utterance must match one mapping. No splitting into commands.
  class CommandMatcher {
    constructor(mappings, language, { confidenceThreshold = 0.85, modelId = 'vosk' } = {}) {
      this.confidenceThreshold = confidenceThreshold;
      this.requireConfidence = modelId === 'vosk';
      this.language = language;
      this.commands = new Map(expandMappings(mappings, language));
      this.reset();
    }
    reset() { this.lastFingerprint = ''; }
    assess(text, final = false, words = []) {
      const value = normalize(text);
      const result = { accepted: false, text: cleanPhrase(text), reason: 'partial', confidence: null };
      // A partial hypothesis can be revised or withdrawn. It must NEVER press a key.
      if (!final) return result;
      if (!value) return { ...result, reason: 'empty' };
      if (/\[unk\]/i.test(text)) return { ...result, reason: 'unknown_speech' };
      const candidate = this.commands.get(speechKey(value, this.language));
      if (!candidate) return { ...result, reason: 'phrase_not_configured' };
      // Phrases learned from the user's own voice were heard as-is: the model's score for them is not a signal.
      if (!this.requireConfidence || candidate.learned) {
        if (this.lastFingerprint === value) return { ...result, reason: 'duplicate_result' };
        this.lastFingerprint = value;
        return { ...result, accepted: true, reason: 'matched', action: this.makeAction(candidate, null) };
      }
      if (!Array.isArray(words) || !words.length || words.length > 40 || words.some(word =>
        !Number.isFinite(word.conf) || word.conf < 0 || word.conf > 1 || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start
      ) || normalize(words.map(word => word.word).join(' ')) !== value) {
        return { ...result, reason: 'word_details_missing' };
      }
      const confidence = words.reduce((sum, word) => sum + word.conf, 0) / words.length;
      const minimumConfidence = Math.min(...words.map(word => word.conf));
      if (confidence < this.confidenceThreshold || minimumConfidence < this.confidenceThreshold - 0.15) {
        return { ...result, confidence, minimumConfidence, reason: 'confidence_too_low' };
      }
      const fingerprint = JSON.stringify(words.map(word => [word.word, word.start, word.end]));
      if (fingerprint === this.lastFingerprint) return { ...result, confidence, reason: 'duplicate_result' };
      this.lastFingerprint = fingerprint;
      return { ...result, accepted: true, reason: 'matched', confidence, minimumConfidence,
        action: this.makeAction(candidate, confidence) };
    }
    makeAction(candidate, confidence) { return buildAction(candidate, { confidence }); }
    accept(text, final = false, words = []) {
      return this.assess(text, final, words).action || null;
    }
  }
  class WordCommandMatcher {
    // prefixChars > 0: an unfinished last word fires its command as soon as it has that many letters and starts
    // exactly one command. A word that could still become a different command waits ambiguousWaitMs (or the end of the utterance).
    constructor(mappings, language, { wordStabilityMs = 100, prefixChars = 0, ambiguousWaitMs = 150, now = monotonicNow } = {}) {
      this.language = language; this.stability = wordStabilityMs; this.now = now;
      this.prefixChars = prefixChars; this.ambiguousWait = ambiguousWaitMs;
      this.commands = new Map(expandMappings(mappings, language).filter(([, mapping]) => normalize(mapping.phrase).split(' ').length === 1));
      // prefix -> the distinct actions whose command word starts with it (variants of one action count once)
      this.prefixes = new Map();
      if (prefixChars > 0) for (const [word, candidate] of this.commands) {
        const id = actionIdentity(candidate);
        for (let length = 1; length < word.length; length++) {
          const prefix = word.slice(0, length), group = this.prefixes.get(prefix) || new Map();
          if (!group.has(id)) group.set(id, [word, candidate]);
          this.prefixes.set(prefix, group);
        }
      }
      this.reset();
    }
    // Which command does this word stand for? Only a word still being spoken (unfinished) may match by prefix.
    resolve(token, unfinished) {
      const exact = this.commands.get(token);
      if (!unfinished || !this.prefixChars) return exact ? { word: token, candidate: exact, ambiguous: false } : null;
      const longer = this.prefixes.get(token);
      if (exact) {
        const own = actionIdentity(exact);
        return { word: token, candidate: exact, ambiguous: Boolean(longer) && [...longer.keys()].some(id => id !== own) };
      }
      if (token.length >= this.prefixChars && longer && longer.size === 1) {
        const [word, candidate] = [...longer.values()][0];
        return { word, candidate, ambiguous: false, prefix: true };
      }
      return null;
    }
    reset() { this.emitted = new Map(); this.pending = new Map(); this.finalized = false; }
    assess(text, final = false) {
      const tokens = normalize(text).split(' ').filter(Boolean).map(word => speechKey(word, this.language));
      const result = { accepted: false, text: cleanPhrase(text), confidence: null, reason: 'partial', actions: [] };
      if (this.finalized) return { ...result, reason: 'duplicate_result' };
      const now = this.now();
      const counts = new Map(), present = new Set(); let blocked = false, anyCommand = false;
      for (let index = 0; index < tokens.length; index++) {
        const hit = this.resolve(tokens[index], !final && index === tokens.length - 1); if (!hit) continue;
        const { word, candidate } = hit;
        const occurrence = (counts.get(word) || 0) + 1; counts.set(word, occurrence);
        anyCommand = true;
        const identity = `${word}:${occurrence}`; present.add(identity);
        if (!this.pending.has(identity)) this.pending.set(identity, now);
        if (occurrence <= (this.emitted.get(word) || 0)) continue;
        const needed = hit.ambiguous ? Math.max(this.stability, this.ambiguousWait) : this.stability;
        if (blocked || !final && now - this.pending.get(identity) < needed) { blocked = true; continue; }
        this.emitted.set(word, occurrence);
        result.actions.push(buildAction(candidate, { confidence: null, provisional: !final, stabilityMs: now - this.pending.get(identity), firstSeenAt: this.pending.get(identity), occurrence, byPrefix: Boolean(hit.prefix), heard: tokens[index] }));
      }
      for (const identity of this.pending.keys()) if (!present.has(identity)) this.pending.delete(identity);
      if (final) this.finalized = true;
      result.accepted = Boolean(result.actions.length); result.reason = result.accepted ? 'matched' : final ? (tokens.length ? (anyCommand ? 'no_new_word_command' : 'no_command_word') : 'empty') : 'partial';
      return result;
    }
  }
  // Two command words that press the same thing are one action: "ку" and "кью" never make each other ambiguous.
  function actionIdentity(candidate) {
    const type = isWheel(candidate.key) ? 'tap' : candidate.actionType;
    return `${candidate.key}|${canonicalModifiers(candidate.modifiers).join('+')}|${type === 'hold' ? `hold${candidate.durationMs ?? 1000}` : type === 'toggle' ? 'toggle' : 'tap'}`;
  }
  function buildAction(candidate, extra) {
    const modifiers = canonicalModifiers(candidate.modifiers), actionType = isWheel(candidate.key) || !['hold', 'toggle'].includes(candidate.actionType) ? 'tap' : candidate.actionType;
    return { phrase: candidate.phrase, key: candidate.key, modifiers, label: actionLabel(candidate.key, modifiers), language: candidate.language,
      actionType, durationMs: actionType === 'hold' ? candidate.durationMs ?? 1000 : 65, ...extra };
  }
  function validateSound(value = {}) {
    return { enabled: value?.enabled !== false, volume: bounded(value?.volume, 0, 100, 40), onMatch: value?.onMatch !== false, onPress: value?.onPress !== false };
  }
  function createMatcher(config) { return config.commandMode === 'words' ? new WordCommandMatcher(config.mappings, config.language, { ...config, prefixChars: config.prefixMatch === false ? 0 : PREFIX_LETTERS }) : new CommandMatcher(config.mappings, config.language, config); }
  function bounded(value, minimum, maximum, fallback) { return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback; }
  function validateOverlay(value = {}) {
    return { enabled: value.enabled !== false, orientation: value.orientation === 'vertical' ? 'vertical' : 'horizontal', anchor: ['top','bottom','left','right'].includes(value.anchor) ? value.anchor : 'top', offsetX: bounded(value.offsetX,-10000,10000,0), offsetY: bounded(value.offsetY,-10000,10000,100), size: bounded(value.size,28,80,44), retentionMs: bounded(value.retentionMs,500,15000,2500) };
  }
  return { monotonicNow, libraryWord, trainedList, KEYS, KEYBOARD_KEYS, MOUSE_KEYS, MODIFIERS, KEY_LABELS, KEY_DESCRIPTIONS, MODIFIER_LABELS, isWheel, canonicalModifiers, keyLabel, actionLabel, validateSound, DEFAULTS, MAX_PHRASES, normalize, cleanPhrase, phraseList, expandMappings, speechKey, validateConfig, validateOverlay, CommandMatcher, WordCommandMatcher, createMatcher, buildAction };
});
