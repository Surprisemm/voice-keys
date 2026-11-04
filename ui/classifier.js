'use strict';
// "Свой классификатор голоса", in this order: 1 Python and PyTorch, 2 the profile (the same profiles as the commands; the general one is always there),
// 3 the words of the profile (recorded by hand), 4 the background (one for all profiles), 5 training of the network of the profile.
// Uses the globals of app.js (config, currentState, ready, prepare, notice, captureRate, audioTap) and window.performProfile / openProfileDialog / syncSettings / applyConfigQuiet.
(() => {
  const GOOD = 30, MIN = 8;
  let status = null, ml = null, recording = null, trainingActive = false, setupActive = false;
  const el = id => document.getElementById(id);
  const cleanWord = text => String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9-]/g, '').slice(0, 30);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const armed = () => Boolean(currentState?.armed);
  const busy = () => Boolean(recording) || trainingActive || setupActive;
  const unlocked = () => Boolean(ml?.installed && !ml.broken);
  const counts = () => status?.words || {};
  const profiles = () => status?.profiles || [];
  const active = () => profiles().find(profile => profile.id === status?.activeProfileId) || null;
  const make = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const when = iso => iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const info = () => ({ words: counts(), models: status?.models || {}, activeProfileId: status?.activeProfileId, profiles: profiles() });
  const cover = (words, profileId) => window.neuralCoverage(words, info(), profileId);
  const takes = n => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'повторение' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'повторения' : 'повторений'}`;
  const shade = count => count >= GOOD ? 'good' : count >= MIN ? 'fair' : 'few'; // green: recorded fully, yellow: not enough yet, red: not used in training

  // a message shows up in the step of the button that was pressed (near), not at the top of the panel
  let lastNear = null;
  function say(text, kind = '', near = lastNear) {
    const box = el('cls-message'); lastNear = near;
    const section = near?.closest?.('section'); if (section && box.parentElement !== section) section.insertBefore(box, section.children[1] || null);
    box.textContent = text; box.className = `cls-message ${kind}`; box.hidden = !text;
  }
  function badge(id, text, kind = '') { const node = el(id); node.textContent = text; node.className = `cls-badge ${kind}`; node.hidden = !text; }
  // an explanation of the state of a profile and its network
  function explain(result, profile) {
    if (result.level === 'empty') return profile.general ? 'В библиотеке пока нет слов: запишите первое слово (шаг 3).' : 'В профиле нет слов: запишите или добавьте их (шаг 3).';
    const few = result.norecord.filter(word => !result.empty.includes(word));
    if (result.level === 'none') return 'Сеть профиля не обучена: нажмите «Обучить» (шаг 5).';
    if (result.level === 'stale') {
      return [result.missing.length && `Записаны, но сеть их не знает: ${result.missing.join(', ')}.`, result.empty.length && `Не записаны, в обучение не попали: ${result.empty.join(', ')}.`, few.length && `Мало записей (нужно ${MIN}+): ${few.join(', ')}.`, result.newer.length && `После обучения записаны ещё повторы: ${result.newer.join(', ')}.`].filter(Boolean).join(' ') + (result.empty.length || few.length ? ' Запишите недостающее и переобучите сеть.' : ' Переобучите сеть.');
    }
    return `Все слова профиля есть в сети. Слушает ${result.scope === 'shared' ? 'общая сеть' : 'сеть профиля'}.`;
  }
  const LEVEL = { empty: ['', 'слов нет'], none: ['bad', 'сеть не обучена'], stale: ['warn', 'сеть устарела'], ok: ['good', 'сеть обучена'] };
  const DOT = { empty: 'none', none: 'bad', stale: 'warn', ok: 'good' };

  // The next thing to do for the active profile, in the order of the steps.
  function nextStep() {
    const profile = active(); if (!status || !profile || !ml) return '';
    if (!unlocked()) return 'Что дальше: установите Python и PyTorch (шаг 1).';
    if (!profile.words.length) return `Что дальше: в профиле «${profile.name}» нет слов, впишите и проговорите первое слово (шаг 3).`;
    const result = cover(profile.words, profile.id);
    if (result.norecord.length) return `Что дальше: запишите слова ${result.norecord.join(', ')} (шаг 3).`;
    if (!status.backgroundSeconds) return 'Что дальше: запишите фон — обычную речь и звуки игры без команд (шаг 4).';
    if (result.level === 'none') return `Что дальше: обучите сеть профиля «${profile.name}» (шаг 5).`;
    if (result.level === 'stale') return `Что дальше: переобучите сеть (шаг 5) — ${result.missing.length ? `в неё не вошли: ${result.missing.join(', ')}` : 'есть новые записи'}.`;
    return `Профиль «${profile.name}»: всё готово, слушает ${result.scope === 'shared' ? 'общая сеть' : 'своя сеть профиля'}.`;
  }
  function renderNow() { const text = nextStep(), box = el('cls-now'); box.textContent = text; box.hidden = !text; box.classList.toggle('done', text.includes('всё готово')); }

  // ---------- step 1 ----------
  function renderMl() {
    const box = el('cls-ml-text'), button = el('cls-ml-install'), badgeKind = unlocked() ? 'good' : 'bad';
    button.hidden = true;
    if (!ml) { box.textContent = 'Проверяю окружение для обучения…'; badge('cls-env-badge', ''); return; }
    if (ml.installed && !ml.broken) { box.textContent = `Установлено: PyTorch ${ml.torch}${ml.cuda ? `, видеокарта ${ml.gpu}` : ', обучение на процессоре'}.`; badge('cls-env-badge', 'готово', badgeKind); }
    else if (ml.broken) { box.textContent = 'Окружение Python повреждено. Установите заново.'; button.hidden = !ml.canInstall; button.textContent = 'Установить заново'; badge('cls-env-badge', 'нужно починить', badgeKind); }
    else {
      box.textContent = 'Python и PyTorch не установлены.';
      if (ml.canInstall) { button.hidden = false; button.textContent = 'Установить Python и PyTorch'; } else box.textContent += ' Нужен Python 3.10–3.13 (python.org) или uv.';
      badge('cls-env-badge', 'не установлено', badgeKind);
    }
    button.disabled = busy() || armed();
  }
  function renderLock() { const open = unlocked(); el('cls-locked').disabled = !open; el('cls-locked').classList.toggle('is-locked', !open); el('cls-lock-note').hidden = open || !ml; }

  // ---------- step 2: the profile ----------
  function renderProfiles() {
    const box = el('cls-profiles'), current = active(), locked = busy() || armed();
    box.replaceChildren();
    for (const profile of profiles()) {
      const result = cover(profile.words, profile.id), tab = make('button', `cls-tab${profile.id === current?.id ? ' selected' : ''}`);
      tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(profile.id === current?.id)); tab.disabled = locked;
      tab.append(make('span', `cls-dot ${DOT[result.level]}`), make('span', '', profile.name)); tab.title = `${LEVEL[result.level][1]}. ${explain(result, profile)}`;
      tab.onclick = () => { if (profile.id !== current?.id) window.performProfile({ operation: 'switch', id: profile.id }); };
      box.append(tab);
    }
    el('cls-profile-new').disabled = locked; el('cls-profile-duplicate').disabled = locked || !current;
    el('cls-profile-rename').disabled = locked || !current || current.general; el('cls-profile-delete').disabled = locked || !current || current.general;
    if (current) {
      const result = cover(current.words, current.id), [kind, label] = LEVEL[result.level];
      badge('cls-profile-badge', label, kind);
      el('cls-profile-note').textContent = current.general ? 'Общий профиль есть всегда, его нельзя удалить или переименовать. Он знает все записанные слова, его сеть общая и работает в профилях, у которых нет своей.' : explain(result, current);
    }
  }

  // ---------- step 3: the words of the profile ----------
  function renderWords() {
    const box = el('cls-words'), profile = active(), locked = armed() || busy();
    if (recording) { updateWordCounts(); for (const button of box.querySelectorAll('button:not(.rec-stop)')) if (!button.hidden) button.disabled = true; return; } // the recording sits on a button of a row
    box.replaceChildren();
    if (!profile) return;
    const result = cover(profile.words, profile.id), state = Object.fromEntries(result.states.map(item => [item.word, item.state]));
    el('cls-words-help').textContent = profile.general ? 'В общем профиле все слова библиотеки. Впишите новое слово и проговорите его; × стирает записи слова совсем.' : 'Впишите слово и проговорите его, либо добавьте уже записанное слово из библиотеки. × убирает слово из профиля (записи остаются в библиотеке).';
    if (!profile.words.length) box.append(make('div', 'cls-sub', 'В профиле пока нет слов. Впишите слово выше и нажмите «Записать слово».'));
    for (const word of profile.words) {
      const count = counts()[word] || 0, row = make('div', 'cls-row cls-word-row'); row.dataset.word = word;
      const amount = make('span', `cls-count ${shade(count)}`, `${count}`);
      amount.title = count >= GOOD ? 'Записей достаточно.' : count >= MIN ? `Недозаписано: лучше ${GOOD} повторений, пока ${count}.` : count ? `Мало: нужно хотя бы ${MIN}, пока ${count}. В обучении не участвует.` : 'Записей нет. В обучении не участвует.';
      const net = make('span', `cls-chip ${state[word] === 'trained' ? 'good' : count >= MIN ? 'fair' : 'few'}`, state[word] === 'trained' ? 'в сети' : count >= MIN ? 'сеть не знает' : count ? 'мало записей' : 'нет записей');
      net.title = state[word] === 'trained' ? 'Сеть обучена на этом слове.' : count >= MIN ? 'Слово записано, но сеть на нём ещё не обучена: переобучите сеть.' : 'Слово не войдёт в обучение.';
      const more = make('button', 'button subtle', 'Записать ещё'); more.type = 'button'; more.disabled = locked; more.onclick = () => recordWord(word, more);
      const redo = make('button', 'button subtle', 'Перезаписать'); redo.type = 'button'; redo.disabled = locked || !count; redo.title = 'Стереть записи слова и записать заново';
      redo.onclick = async () => { if (!confirm(`Стереть ${count} записей слова «${word}» и записать заново?`)) return; await window.voiceKeys.classifierRemove({ kind: 'word', word }); recordWord(word, redo); };
      const undo = make('button', 'small-button', '↶'); undo.type = 'button'; undo.title = 'Удалить последнюю запись'; undo.disabled = locked || !count; undo.onclick = async () => { await window.voiceKeys.classifierRemove({ kind: 'last', word }); await refresh(); };
      const remove = make('button', 'small-button', '×'); remove.type = 'button'; remove.disabled = locked; remove.title = profile.general ? 'Стереть все записи слова' : 'Убрать слово из профиля (записи останутся)';
      remove.onclick = () => removeWord(word, profile, count);
      row.append(make('span', 'cls-word', word), amount, net, more, redo, undo, remove); box.append(row);
    }
    // the library: recorded words that this profile does not have yet
    const library = el('cls-library'), spare = profile.general ? [] : Object.keys(counts()).filter(word => !profile.words.includes(word)).sort();
    library.replaceChildren(make('option', '', '＋ из библиотеки…')); library.firstChild.value = '';
    for (const word of spare) { const option = make('option', '', `${word} · ${counts()[word]}`); option.value = word; library.append(option); }
    library.hidden = profile.general || !spare.length; library.disabled = locked;
    // warnings: red words do not take part in training, yellow ones are recorded too few times
    const red = profile.words.filter(word => (counts()[word] || 0) < MIN), yellow = profile.words.filter(word => (counts()[word] || 0) >= MIN && counts()[word] < GOOD);
    const warn = el('cls-words-warn'), lines = [];
    if (red.length) lines.push(`Не войдут в обучение (меньше ${MIN} записей): ${red.join(', ')}.`);
    if (yellow.length) lines.push(`Недозаписаны (лучше ${GOOD} повторений): ${yellow.join(', ')}. Сеть будет хуже узнавать их.`);
    warn.textContent = lines.join(' '); warn.hidden = !lines.length; warn.className = `cls-warn ${red.length ? 'bad' : 'warn'}`;
    const total = profile.words.length;
    badge('cls-words-badge', total ? `${total} сл., готовы к обучению: ${profile.words.length - red.length}` : 'нет слов', total && !red.length && !yellow.length ? 'good' : total ? 'fair' : 'bad');
  }
  // the counters of the rows while a recording is going on
  function updateWordCounts() {
    for (const row of el('cls-words').querySelectorAll('.cls-word-row')) {
      const count = counts()[row.dataset.word] || 0, amount = row.querySelector('.cls-count');
      amount.textContent = `${count}`; amount.className = `cls-count ${shade(count)}`;
    }
  }
  async function removeWord(word, profile, count) {
    if (profile.general) { if (!confirm(`Стереть все записи слова «${word}» (${count})? Слово пропадёт из библиотеки и из общего профиля.`)) return; await window.voiceKeys.classifierRemove({ kind: 'word', word }); await refresh(); return; }
    const result = await window.voiceKeys.classifierProfileWords({ profileId: profile.id, operation: 'remove', word });
    if (!result.ok) { say(result.error, 'bad'); return; }
    window.applyConfigQuiet(result.config); await refresh();
  }
  async function addToProfile(word) {
    const profile = active(); if (!profile || profile.general) return true;
    if (!await window.syncSettings()) return false;
    const result = await window.voiceKeys.classifierProfileWords({ profileId: profile.id, operation: 'add', word });
    if (!result.ok) { say(result.error, 'bad'); return false; }
    window.applyConfigQuiet(result.config); await refresh(); return true;
  }

  // ---------- step 4 ----------
  function renderBackground() {
    el('cls-bg-info').textContent = status?.backgroundSeconds ? `Записано: ${status.backgroundSeconds} с (${status.backgroundFiles} файл.)` : 'Фона пока нет.';
    el('cls-bg-clear').disabled = !status?.backgroundSeconds || busy() || armed(); el('cls-bg-record').disabled = busy() || armed();
    badge('cls-bg-badge', status?.backgroundSeconds ? `${status.backgroundSeconds} с` : 'нет', status?.backgroundSeconds ? 'good' : 'fair');
  }

  // ---------- step 5: training ----------
  function renderTraining() {
    const profile = active(); if (!profile) return;
    const have = counts(), ready = profile.words.filter(word => (have[word] || 0) >= MIN), weak = ready.filter(word => have[word] < GOOD);
    const left = profile.words.filter(word => (have[word] || 0) < MIN);
    const result = cover(profile.words, profile.id), own = profile.general ? status?.models?.shared : status?.models?.[profile.id];
    el('cls-train-help').textContent = profile.general ? 'Общая сеть учится на всех словах библиотеки и общем фоне.' : `Сеть профиля «${profile.name}» учится на его словах и общем фоне.`;
    const button = el('cls-train'); button.textContent = own ? 'Переобучить' : 'Обучить'; button.disabled = busy() || armed() || !unlocked() || !ready.length;
    const warn = el('cls-train-warn'), lines = [];
    let kind = 'warn';
    if (!profile.words.length) { lines.push('В профиле нет слов: кнопка недоступна. Запишите слова (шаг 3).'); kind = 'bad'; }
    else if (!ready.length) { lines.push(`Ни у одного слова нет ${MIN} записей: кнопка недоступна. Допишите слова (шаг 3).`); kind = 'bad'; }
    else {
      if (left.length) lines.push(`В обучение не войдут (мало записей): ${left.join(', ')}.`);
      if (weak.length) lines.push(`Недозаписаны (меньше ${GOOD}): ${weak.join(', ')}.`);
      if (!status?.backgroundSeconds) lines.push('Фона нет: ложных срабатываний будет больше (шаг 4).');
    }
    warn.textContent = lines.join(' '); warn.hidden = !lines.length; warn.className = `cls-warn ${kind}`;
    el('cls-model-remove').hidden = !own; el('cls-model-remove').disabled = busy() || armed();
    el('cls-model-line').textContent = own && !own.broken ? `Сеть: ${own.words.join(', ')} · обучена ${when(own.createdAt)}${own.row ? ` · найдено ${Math.round(own.row.detected * 100)}%, ложных на фоне ${own.row.backgroundFalse}, медиана ${own.row.latencyMedianMs == null ? '—' : Math.round(own.row.latencyMedianMs)} мс` : ''}` : own?.broken ? 'Файл сети повреждён, обучите заново.' : '';
    const [badgeKind, label] = LEVEL[result.level]; badge('cls-train-badge', label, badgeKind);
  }

  function renderAll() {
    renderMl(); renderLock(); renderNow(); renderProfiles(); renderWords(); renderBackground(); renderTraining();
    const profile = active(), locked = busy() || armed();
    el('cls-new-word').disabled = el('cls-add-word').disabled = locked;
    window.onClassifierInfo?.(info());
    void profile;
  }
  async function refresh() { const result = await window.voiceKeys.classifierStatus(); if (result.ok) { status = result; trainingActive = result.training; setupActive = result.setup; } renderAll(); }
  async function refreshMl() { ml = await window.voiceKeys.classifierMl(); renderAll(); }

  // ---------- recording ----------
  async function ensureAudio() {
    if (armed()) { say('Сначала остановите прослушивание.', 'bad'); return false; }
    if (!ready) { if (!await prepare()) { say('Не удалось подключить микрофон. Подробности — в сообщении сверху.', 'bad'); return false; } }
    return true;
  }
  // Listens until a word has been said and a pause followed (or 3.2 s have passed); resolves with all samples of that time.
  function captureTake(signal) {
    return new Promise(resolve => {
      const blocks = []; let total = 0, floor = null, firstLoud = -1, lastLoud = -1; const quiet = [];
      audioTap = samples => {
        const copy = samples.slice(); blocks.push(copy); total += copy.length;
        let sum = 0; for (const value of copy) sum += value * value; const rms = Math.sqrt(sum / copy.length), time = total / captureRate;
        if (time < 0.4) quiet.push(rms);
        else {
          if (floor === null) { quiet.sort((a, b) => a - b); floor = Math.max((quiet[Math.floor(quiet.length / 2)] || 0) * 3, 0.006); }
          if (rms > floor) { if (firstLoud < 0) firstLoud = time; lastLoud = time; }
        }
        const finished = (firstLoud >= 0 && time - lastLoud > 0.4) || time > 3.2 || signal.stopped;
        if (finished) {
          audioTap = null;
          const all = new Float32Array(total); let at = 0; for (const block of blocks) { all.set(block, at); at += block.length; }
          resolve(signal.stopped ? null : all);
        }
      };
    });
  }
  async function recordWord(word, host) {
    if (busy() || !unlocked()) return;
    const target = Math.max(5, Math.min(100, Number(el('cls-takes').value) || GOOD)), signal = { stopped: false };
    // the recording appears on the button at once (the page is not rebuilt while it runs), then the microphone is connected
    const widget = window.inlineRecorder(host); widget.onStop(() => { signal.stopped = true; }); widget.setText(`0 из ${target}`); widget.setNote('Подключаю микрофон…');
    recording = { kind: 'word', word, signal }; renderAll(); say('', '', host);
    let done = 0, rejected = 0;
    try {
      if (!await ensureAudio()) return;
      while (!signal.stopped && done < target) {
        widget.setNote('Подождите…'); await sleep(450); if (signal.stopped) break;
        widget.setNote(`Скажите «${word}»`);
        const samples = await captureTake(signal); if (!samples) break;
        const result = await window.voiceKeys.classifierTake(word, samples, captureRate);
        if (result.ok) { done++; rejected = 0; widget.setNote(''); }
        else { rejected++; widget.setNote(result.reason, 'bad'); await sleep(1100); if (rejected >= 8) { say('Много неудачных попыток подряд. Проверьте микрофон и уровень громкости.', 'bad', host); break; } }
        status = { ...status, ...(await window.voiceKeys.classifierStatus()) }; updateWordCounts(); widget.setText(`${done} из ${target}`);
      }
      if (done >= target) say(`Готово: записано ${takes(done)} слова «${word}».`, 'good', host);
      else if (signal.stopped && done) say(`Остановлено: записано ${takes(done)} слова «${word}». Можно дозаписать или перезаписать.`, 'good', host);
    } finally { audioTap = null; widget.end(); recording = null; await refresh(); }
  }
  async function recordBackground(host) {
    if (busy() || !unlocked()) return;
    const seconds = Number(el('cls-bg-seconds').value) || 120, signal = { stopped: false }, blocks = []; let total = 0;
    const widget = window.inlineRecorder(host); widget.onStop(() => { signal.stopped = true; }); widget.setText(`0 из ${seconds} с`); widget.setNote('Подключаю микрофон…');
    recording = { kind: 'background', signal }; renderAll(); say('', '', host);
    if (!await ensureAudio()) { widget.end(); recording = null; await refresh(); return; }
    widget.setNote('Говорите, играйте, стучите по клавишам. Команды не произносите.');
    await new Promise(resolve => {
      audioTap = samples => {
        blocks.push(samples.slice()); total += samples.length;
        const time = total / captureRate; widget.setText(`${Math.floor(time)} из ${seconds} с`);
        if (time >= seconds || signal.stopped) { audioTap = null; resolve(); }
      };
    });
    const all = new Float32Array(total); let at = 0; for (const block of blocks) { all.set(block, at); at += block.length; }
    audioTap = null; widget.end();
    if (total / captureRate >= 2) { const result = await window.voiceKeys.classifierBackground(all, captureRate); say(result.ok ? `Фон записан: ${result.seconds} с.` : result.reason, result.ok ? 'good' : 'bad', host); }
    recording = null; await refresh();
  }
  function stopRecording() { if (recording) recording.signal.stopped = true; } // the program stops listening: the recording stops

  // ---------- training and environment ----------
  async function train() {
    const profile = active(); if (!profile) return; say('');
    const result = await window.voiceKeys.classifierTrain({ quality: el('cls-quality').value, profileId: profile.id });
    if (!result.ok) { say(result.error, 'bad', el('cls-train')); return; }
    trainingActive = true; el('cls-progress').hidden = false; el('cls-progress').value = 0; el('cls-cancel').hidden = false;
    el('cls-progress-text').textContent = `Обучение сети профиля «${profile.name}» на PyTorch: ${result.words.join(', ')}…`; el('cls-result').textContent = ''; renderAll();
  }
  function onProgress(message) {
    if (message.steps) el('cls-progress').value = (message.step || 0) / message.steps;
    if (message.message) el('cls-progress-text').textContent = message.message;
  }
  function onDone(result) {
    trainingActive = false; el('cls-cancel').hidden = true; el('cls-progress').hidden = true;
    if (result.status) status = { ...status, ok: true, ...result.status };
    if (result.ok) {
      el('cls-progress-text').textContent = `Готово${result.seconds ? ` за ${result.seconds} с` : ''}. Сеть сохранена.`;
      const rows = (result.rows || []).map(r => `порог ${r.threshold}: найдено ${Math.round(r.detected * 100)}%, ложных на фоне ${r.backgroundFalse}, задержка ${r.latencyMedianMs == null ? '—' : Math.round(r.latencyMedianMs)} мс`);
      el('cls-result').textContent = rows.join('\n');
    } else { el('cls-progress-text').textContent = ''; say(result.error, 'bad'); }
    refresh();
  }
  async function install() {
    const started = await window.voiceKeys.classifierSetup();
    if (!started.ok) { say(started.error, 'bad', el('cls-ml-install')); return; }
    setupActive = true; el('cls-setup-log').hidden = false; el('cls-setup-log').textContent = ''; renderAll();
  }
  function onSetupLine(line) { const log = el('cls-setup-log'); log.textContent = `${log.textContent}${line}\n`.split('\n').slice(-12).join('\n'); log.scrollTop = log.scrollHeight; }
  async function onSetupDone(result) {
    setupActive = false;
    if (!result.ok) say(`Установка не удалась: ${result.error}`, 'bad'); else say('Python и PyTorch установлены. Шаги 2–5 открыты.', 'good');
    await refresh(); await refreshMl();
  }

  async function addWord() {
    const word = cleanWord(el('cls-new-word').value); if (!word) { say('Введите одно слово буквами.', 'bad'); return; }
    if (!await addToProfile(word)) return;
    el('cls-new-word').value = ''; recordWord(word, el('cls-add-word'));
  }
  function boot() {
    if (!el('classifier-panel')) return;
    el('cls-add-word').onclick = addWord; el('cls-new-word').onkeydown = event => { if (event.key === 'Enter') addWord(); };
    el('cls-library').onchange = async () => { const word = el('cls-library').value; el('cls-library').value = ''; if (word) await addToProfile(word); };
    el('cls-bg-record').onclick = () => recordBackground(el('cls-bg-record'));
    el('cls-bg-clear').onclick = async () => { if (confirm('Удалить все записи фона?')) { await window.voiceKeys.classifierRemove({ kind: 'background' }); await refresh(); } };
    el('cls-train').onclick = train; el('cls-cancel').onclick = () => window.voiceKeys.classifierCancel();
    el('cls-model-remove').onclick = async () => { const profile = active(); if (profile && confirm(`Удалить обученную сеть профиля «${profile.name}»? Записи останутся.`)) { await window.voiceKeys.classifierRemove({ kind: 'model', scope: profile.id }); await refresh(); } };
    for (const [id, operation] of [['cls-profile-new', 'create'], ['cls-profile-duplicate', 'duplicate'], ['cls-profile-rename', 'rename'], ['cls-profile-delete', 'delete']]) el(id).onclick = () => window.openProfileDialog(operation, status?.activeProfileId);
    el('cls-ml-install').onclick = install;
    el('cls-help-btn').onclick = () => { const open = el('cls-howto').hidden; el('cls-howto').hidden = !open; el('cls-help-btn').setAttribute('aria-expanded', String(open)); };
    window.voiceKeys.onClassifierProgress(onProgress); window.voiceKeys.onClassifierDone(onDone); window.voiceKeys.onClassifierSetupLine(onSetupLine); window.voiceKeys.onClassifierSetupDone(onSetupDone);
    el('classifier-panel').addEventListener('toggle', () => { if (el('classifier-panel').open) { refresh(); if (!ml) refreshMl(); } });
    refresh();
    if (el('classifier-panel').open) refreshMl();
  }
  window.classifierOnState = () => { if (recording && armed()) stopRecording(); renderAll(); };
  window.classifierRefresh = refresh;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0)); else setTimeout(boot, 0);
})();
