'use strict';
const { app, BrowserWindow, session, globalShortcut, shell, screen, Tray, Menu, nativeImage, nativeTheme, dialog, net } = require('electron');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { ipcMain } = require('electron');
const { DEFAULTS, createMatcher, WordCommandMatcher, buildAction, expandMappings, monotonicNow, phraseList, libraryWord } = require('./core');
const { Worker } = require('node:worker_threads');
const { execFile } = require('node:child_process');
const { createKeyController } = require('./key-controller');
const { createNativeInput } = require('./native-input');
const { createLogger } = require('./logger');
const { sameOrigin, microphoneCheck } = require('./permissions');
const {validateStore,changeProfile,changeProfileWords,exportProfiles,importProfiles,defaultStore,GENERAL_ID}=require('./profiles');
const {drawAppIcon,GREEN,GREY}=require('./tray-icon');
const {MODELS,VOSK,CATALOG,modelFiles,modelFilesReady,voskArchive}=require('./models');
const {ActionTimeline,overlayBounds}=require('./overlay');
const {createSampleStore}=require('./samples');
const {createWasapiCapture}=require('./wasapi-capture');
const {createClassifierStore}=require('./classifier/store');
const {createArbiter,signature:actionSignature}=require('./classifier/arbiter');
const {startTraining}=require('./classifier/trainer');
const {profileWords,trainingPlan,chooseModel,scopeOf}=require('./classifier/scopes');
const mlSetup=require('./ml-setup');
const {resolveDataDir,legacyToImport}=require('./data-location');
const {importData,inspect:inspectData}=require('./data-import');

const ROOT = path.resolve(__dirname, '..');
// Data folder: next to the portable exe, %APPDATA%\Voice Keys when installed, <project>/data in development (see data-location.js).
const LOCATION = resolveDataDir({ isPackaged: app.isPackaged, appData: app.getPath('appData'), execPath: process.execPath, root: ROOT });
const DATA = LOCATION.dir;
const startHidden = process.argv.includes('--hidden');
const NATIVE_CAPTURE_EXE = app.isPackaged ? path.join(process.resourcesPath, 'native', 'WasapiCapture.exe') : path.join(ROOT, 'native', 'WasapiCapture.exe');
const BUNDLED_MODELS = app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(ROOT, 'models');
// VOICE_KEYS_MODELS_DIR: all models live in that folder (tests of the download)
const DOWNLOADED_MODELS = process.env.VOICE_KEYS_MODELS_DIR || (app.isPackaged ? path.join(DATA, 'models') : path.join(ROOT, 'models'));
const MODEL_ROOTS = process.env.VOICE_KEYS_MODELS_DIR ? [DOWNLOADED_MODELS] : [...new Set([BUNDLED_MODELS, DOWNLOADED_MODELS])];
fs.mkdirSync(DATA, { recursive: true });
const legacyFolder = legacyToImport(LOCATION);
if (legacyFolder) { try { importData(legacyFolder, DATA); } catch { /* the app starts with defaults */ } }
const firstRun = !fs.existsSync(path.join(DATA, 'settings.json'));
app.setPath('userData', path.join(DATA, 'electron'));
app.setAppUserModelId('local.voice-keys');
const CONFIG = path.join(DATA, 'settings.json');
const logger = createLogger(path.join(DATA, 'logs'));
logger.write('app.start', { version: app.getVersion(), platform: process.platform, arch: process.arch, dataDirectory: DATA });
process.on('uncaughtException', error => {
  logger.write('app.uncaught_exception', { message: error.message, stack: error.stack }, 'error');
  console.error(error);
  app.quit();
});
process.on('unhandledRejection', error => {
  logger.write('app.unhandled_rejection', { message: String(error), stack: error?.stack }, 'error');
  console.error(error);
  post('warning', `Ошибка приложения: ${String(error)}`);
});
let startupWarning = '';
let config;
// Before every command had its own neural words, the classifier used the one-word phrases it had recordings for: they become the neural words.
function migrateTrainedWords(raw) {
  let library; try { library = new Set(fs.readdirSync(path.join(DATA, 'classifier', 'words'))); } catch { library = new Set(); }
  const fix = list => { for (const mapping of Array.isArray(list) ? list : []) if (mapping && mapping.trainedWords === undefined) mapping.trainedWords = phraseList(mapping).filter(phrase => !/s/.test(phrase)).map(libraryWord).filter(word => library.has(word)); };
  fix(raw.mappings); for (const profile of Array.isArray(raw.profiles) ? raw.profiles : []) fix(profile?.settings?.mappings);
  return raw;
}
try { config = validateStore(migrateTrainedWords(JSON.parse(fs.readFileSync(CONFIG, 'utf8')))); }
catch (error) {
  config = defaultStore(DEFAULTS);
  if (error.code !== 'ENOENT') startupWarning = `Не удалось прочитать настройки. Загружены примеры. ${error.message}`;
}
logger.write('settings.loaded', { config, fallback: Boolean(startupWarning), warning: startupWarning });
let matcher = createMatcher(config);
let win, server, origin, native, capture = null;
let armed = false, listening = false, voiceReady = false, epoch = 0, acceptUntil = 0, enrolling = false;
let stopping = false, quitting = false;
let tray = null, trayState = '', trayImages = {}, appIcon = null, trayHintShown = false, lastOnsetAt = 0;
let tickTimer;
let finalizeTimer;
let lastRecognitionLog = '';
let actionNumber = 0;
let segment = -1, finishedSegment = -1, wordHypothesis = null, nativeWorker = null, nativePrepared = '';
const activeActions = new Map();
const inputOptions={gapMs:()=>config.queueGapMs,releaseGapMs:20};
const previewDown = new Set(); // the preview presses nothing, but a toggled key must read as down until it is lifted
const previewInput = createKeyController({ down: key => (previewDown.add(key), true), up: key => (previewDown.delete(key), true), isDown: key => previewDown.has(key), modifiersDown: () => false },inputOptions);
const timeline=new ActionTimeline({retentionMs:()=>config.overlay.retentionMs});
const samples=createSampleStore(path.join(DATA,'samples'));
const classifierStore=createClassifierStore(path.join(DATA,'classifier'));
const ML_DIR=path.join(DATA,'ml'), ML_SCRIPTS=app.isPackaged?path.join(process.resourcesPath,'tools','ml'):path.join(ROOT,'tools','ml');
let classifierTraining=null,mlSetupRunning=false,mlProbe=null;
// Personal classifier at run time: a worker thread with the trained model, and an arbiter so that a command heard by both it and the text recognition is pressed once.
let classifierWorker=null,classifierReady=false,classifierCommands=new Map();
const arbiter=createArbiter();
// the words of the neural network of each command of the current language; the text phrases are the recognizer's business
const buildClassifierCommands = () => {
  const commands = new Map();
  for (const mapping of config.mappings) if (mapping.language === config.language) for (const word of mapping.trainedWords || []) if (!commands.has(word)) commands.set(word, { ...mapping, phrase: word, learned: false });
  return commands;
};
classifierCommands = buildClassifierCommands();
let overlayWindow,overlayTimer,overlayFingerprint='',benchmarkBusy=false;
const benchmarkRequests=new Map();
// Downloads through the network stack of the window (it follows the proxy settings of Windows). A download that gets no data for a minute is abandoned.
async function downloadFile(url, file, onProgress) {
  const controller = new AbortController(); let idle = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await net.fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0; let received = 0, last = 0;
    const source = Readable.fromWeb(response.body);
    source.on('data', chunk => { received += chunk.length; clearTimeout(idle); idle = setTimeout(() => controller.abort(), 60000); if (Date.now() - last > 400) { last = Date.now(); onProgress(received, total); } });
    await pipeline(source, fs.createWriteStream(`${file}.part`));
    fs.renameSync(`${file}.part`, file);
  } catch (error) { fs.rmSync(`${file}.part`, { force: true }); throw error; }
  finally { clearTimeout(idle); }
}
const modelStatus = () => ({ installed: { sherpa: modelFilesReady(MODEL_ROOTS, 'sherpa'), gigaam: modelFilesReady(MODEL_ROOTS, 'gigaam'), 'vosk-ru': Boolean(voskArchive(MODEL_ROOTS, 'ru')), 'vosk-en': Boolean(voskArchive(MODEL_ROOTS, 'en')) }, catalog: CATALOG });

function post(channel, data) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, data);
}
function state() {
  return { armed, listening, voiceReady, epoch, language: config.language, listenMode: config.listenMode, holdKey: config.holdKey, outputMode: config.outputMode, modelId: config.modelId, commandMode: config.commandMode };
}
function emitState() { post('state', state()); updateTray(); }
// keepState: swap in new commands without forgetting words already handled in the current utterance.
function rebuildMatcher(keepState = false) {
  const fresh = createMatcher(config);
  if (keepState) {
    if (fresh instanceof WordCommandMatcher && matcher instanceof WordCommandMatcher) { fresh.emitted = matcher.emitted; fresh.pending = matcher.pending; fresh.finalized = matcher.finalized; }
    else if (!(fresh instanceof WordCommandMatcher) && !(matcher instanceof WordCommandMatcher)) fresh.lastFingerprint = matcher.lastFingerprint;
  }
  matcher = fresh;
  classifierCommands = buildClassifierCommands();
}
function persist(next, { keepState = false } = {}){
  if(fs.existsSync(CONFIG)&&!fs.existsSync(CONFIG+'.before-profiles.json'))fs.copyFileSync(CONFIG,CONFIG+'.before-profiles.json');
  fs.writeFileSync(CONFIG+'.tmp',JSON.stringify(next,null,2),'utf8');fs.renameSync(CONFIG+'.tmp',CONFIG);config=next;rebuildMatcher(keepState);emitState();updateOverlay();
}
function showWindow() { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function replaceConfig(reason) {
  post('config-replaced', { config, state: state(), samples: samples.list(config.activeProfileId), reason });
}
function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const name = listening ? 'on' : 'off';
  if (name !== trayState) { tray.setImage(trayImages[name]); trayState = name; }
  const profile = config.profiles?.find(item => item.id === config.activeProfileId)?.name || '';
  const status = !armed ? 'выключено' : listening ? 'слушает' : `ждёт ${config.holdKey}`;
  tray.setToolTip(`Voice Keys — ${status}${profile ? ` · ${profile}` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Voice Keys', click: showWindow },
    { label: `Сейчас: ${status}`, enabled: false },
    armed ? { label: 'Остановить прослушивание', click: () => stop('tray') } : { label: 'Включить прослушивание', click: () => post('request-start') },
    { label: 'Профиль', submenu: (config.profiles || []).map(item => ({ label: item.name, type: 'radio', checked: item.id === config.activeProfileId, click: () => switchProfileFromTray(item.id) })) },
    { label: 'Звуковой сигнал', type: 'checkbox', checked: config.sound.enabled, click: item => applyPrefs({ sound: { ...config.sound, enabled: item.checked } }) },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() }
  ]));
}
function createTray() {
  for (const [name, color] of [['on', GREEN], ['off', GREY]]) trayImages[name] = nativeImage.createFromBitmap(drawAppIcon(32, color), { width: 32, height: 32, scaleFactor: 2 });
  tray = new Tray(trayImages.off); trayState = 'off';
  tray.on('click', () => { if (win?.isVisible() && win.isFocused()) win.hide(); else showWindow(); });
  updateTray();
}
function switchProfileFromTray(id) {
  if (id === config.activeProfileId || benchmarkBusy || enrolling) return;
  try {
    const next = changeProfile(config, { operation: 'switch', id });
    stop('tray-profile'); timeline.items.clear(); persist(next);
    logger.write('profile.changed', { operation: 'switch', id, source: 'tray' }); replaceConfig('tray');
  } catch (error) { post('warning', error.message); }
}
// Appearance, sound and tray options: applied immediately, listening is not interrupted.
function applyPrefs(value) {
  const next = validateStore({ ...config, theme: value.theme ?? config.theme, sound: value.sound ?? config.sound, closeToTray: value.closeToTray ?? config.closeToTray });
  persist(next, { keepState: true }); nativeTheme.themeSource = config.theme;
  post('prefs-changed', { theme: config.theme, sound: config.sound, closeToTray: config.closeToTray });
  return config;
}
function updateOverlay(){
  if(!overlayWindow||overlayWindow.isDestroyed())return;
  const items=timeline.snapshot(),settings=config.overlay;
  const fingerprint=JSON.stringify({settings,items});if(fingerprint===overlayFingerprint)return;overlayFingerprint=fingerprint;
  post('queue-state',items);
  overlayWindow.webContents.send('overlay:update',{settings,items});
  if(!settings.enabled||!items.length){overlayWindow.hide();return;}
  const display=screen.getPrimaryDisplay();
  overlayWindow.setBounds(overlayBounds(settings,display.workArea,items.length));overlayWindow.showInactive();
}
async function createOverlay(){
  overlayWindow=new BrowserWindow({width:80,height:80,show:false,transparent:true,frame:false,focusable:false,resizable:false,skipTaskbar:true,hasShadow:false,webPreferences:{preload:path.join(__dirname,'overlay-preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  overlayWindow.setIgnoreMouseEvents(true,{forward:true});overlayWindow.setAlwaysOnTop(true,'screen-saver');overlayWindow.setMenu(null);
  overlayWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  overlayWindow.webContents.on('will-navigate',(event,url)=>{if(url!==`${origin}/overlay`)event.preventDefault();});
  await overlayWindow.loadURL(`${origin}/overlay`);overlayFingerprint='';updateOverlay();overlayTimer=setInterval(updateOverlay,100);
}
function setListening(value) {
  if (value === listening) return;
  listening = value;
  lastRecognitionLog = '';
  clearTimeout(finalizeTimer);
  if (value) {
    epoch++;
    classifierWorker?.postMessage({ type: 'start', epoch });
    segment = -1; finishedSegment = -1; wordHypothesis = null;
    matcher.reset();
    acceptUntil = Infinity;
  } else {
    // A held-key release permits only the final result of the current utterance.
    acceptUntil = armed ? monotonicNow() + 1000 : 0;
    classifierWorker?.postMessage({ type: 'stop' });
    finalizeTimer = setTimeout(() => { matcher.reset(); }, 1100);
  }
  logger.write('listener.state', { listening, armed, epoch, acceptUntil: Number.isFinite(acceptUntil) ? acceptUntil : 'while-listening' });
  emitState();
}
function stop(reason = 'requested') {
  logger.write('listener.stop', { reason, wasArmed: armed, wasListening: listening, epoch });
  armed = false;
  wordHypothesis = null; nativeWorker?.postMessage({ type: 'stop' }); classifierWorker?.postMessage({ type: 'stop' });
  acceptUntil = 0;
  clearTimeout(finalizeTimer);
  matcher.reset();
  native?.release();
  previewInput.cancelAll(); activeActions.clear(); post('input-state', []);
  timeline.cancel();updateOverlay();
  if (listening) setListening(false);
  else emitState();
}
function trusted(event) { return win && event.sender === win.webContents && event.senderFrame?.url === `${origin}/`; }
// ---------- personal classifier at run time ----------
let classifierScope = null; // the network the worker has loaded: 'shared' or a profile id
function stopClassifier() { classifierReady = false; classifierScope = null; const worker = classifierWorker; classifierWorker = null; worker?.terminate(); }
// Starts the worker when the setting is on and a model exists. Never blocks listening: without it everything works as before.
async function ensureClassifier() {
  if (!config.classifierEnabled) { if (classifierWorker) stopClassifier(); return false; }
  const scope = chooseModel(config.activeProfileId, classifierStore.status().models);
  if (classifierWorker && classifierReady && scope === classifierScope) return true;
  stopClassifier();
  if (!scope) { post('warning', 'Быстрый классификатор включён, но для этого профиля нет обученной сети. Работает обычное распознавание.'); return false; }
  logger.write('classifier.model', { scope, profileId: config.activeProfileId }); classifierScope = scope;
  const worker = new Worker(path.join(__dirname, 'classifier', 'classifier-worker.js'), { workerData: { modelFile: classifierStore.modelPath(scope) } });
  classifierWorker = worker;
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Классификатор не загрузился за 10 секунд.')), 10000);
      worker.on('message', message => {
        if (message.type === 'ready') { clearTimeout(timeout); logger.write('classifier.ready', { words: message.words, threshold: message.threshold, arch: message.arch }); resolve(); }
        else if (message.type === 'error') { clearTimeout(timeout); if (classifierReady) logger.write('classifier.error', { message: message.message }, 'warn'); reject(new Error(message.message)); }
        else if (message.type === 'fire') handleClassifierFire(message);
      });
      worker.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    if (classifierWorker !== worker) return false;
    classifierReady = true;
    worker.once('exit', () => { if (classifierWorker === worker) { classifierWorker = null; classifierReady = false; } });
    return true;
  } catch (error) {
    logger.write('classifier.failed', { message: error.message }, 'warn'); post('warning', `Быстрый классификатор не запустился: ${error.message} Работает обычное распознавание.`);
    if (classifierWorker === worker) stopClassifier(); else worker.terminate();
    return false;
  }
}
function handleClassifierFire(fire) {
  if (!classifierReady || !armed || !voiceReady || !listening || fire.epoch !== epoch || enrolling) return;
  const candidate = classifierCommands.get(fire.word);
  if (!candidate) { logger.write('classifier.ignored', { word: fire.word, reason: 'not in this profile', probability: fire.probability }); return; }
  const firedAt = monotonicNow();
  const action = buildAction(candidate, { confidence: fire.probability, provisional: true, stabilityMs: 0, firstSeenAt: firedAt, occurrence: 1, byClassifier: true, heard: fire.word });
  logger.write('classifier.fire', { word: fire.word, probability: Math.round(fire.probability * 1000) / 1000, streamMs: Math.round(fire.ms), processMs: Math.round(fire.processMs * 100) / 100, key: action.key });
  if (!arbiter.claim('classifier', actionSignature(action))) { logger.write('classifier.deduped', { by: 'classifier', word: fire.word, key: action.key }); return; }
  dispatchAction(action, { decodeMs: fire.processMs });
}
function dispatchAction(action, value) {
  const actionId = ++actionNumber, mode = config.outputMode, receivedAt = monotonicNow();
  const actionEpoch = epoch;
  timeline.enqueue({actionId,...action,mode,at:receivedAt});updateOverlay();post('matched',{actionId,label:action.label||action.key});
  logger.write('action.matched', { actionId, ...action, mode, epoch: actionEpoch, modelId: config.modelId, commandMode: config.commandMode });
  const controller = mode === 'keyboard' ? native : previewInput;
  logger.write(mode === 'keyboard' ? 'input.request' : 'preview.request', { actionId, key: action.key, actionType: action.actionType, durationMs: action.durationMs });
  let started = false;
  controller.perform(action, timing => {
    started = true;
    timeline.start(actionId);updateOverlay();
    // Latency parts: speech onset -> word first seen in text -> command accepted -> key down.
    const firstSeenAt = Number.isFinite(action.firstSeenAt) ? action.firstSeenAt : receivedAt;
    const onsetAt = lastOnsetAt && lastOnsetAt <= firstSeenAt && firstSeenAt - lastOnsetAt < 15000 ? lastOnsetAt : null;
    const latency = { speechToTextMs: onsetAt === null ? null : firstSeenAt - onsetAt, stabilityMs: receivedAt - firstSeenAt, queueMs: timing.startedAt - receivedAt, afterWordMs: timing.startedAt - firstSeenAt, totalMs: onsetAt === null ? null : timing.startedAt - onsetAt, decodeMs: Number.isFinite(value?.decodeMs) ? Math.round(value.decodeMs) : null };
    const detail = { actionId, ...action, at: timing.startedAt, mode, ok: true, reason: '', phase: 'down', epoch: actionEpoch, dispatchMs: timing.startedAt - receivedAt, modelId: config.modelId, latency };
    activeActions.set(action.key, detail); post('input-state', [...activeActions.values()]);
    logger.write(mode === 'keyboard' ? 'input.started' : 'action.preview', detail); post('action', detail);
  }).then(outcome => {
    timeline.finish(actionId,outcome);updateOverlay();
    if (activeActions.get(action.key)?.actionId === actionId) activeActions.delete(action.key);
    post('input-state', [...activeActions.values()]);
    logger.write(mode === 'keyboard' ? 'input.result' : 'preview.result', { actionId, ...action, ...outcome }, outcome.ok ? 'info' : 'warn');
    if (started) post('released', { actionId, key: action.key, ...outcome });
    else if (outcome.toggledOff) post('action', { actionId, ...action, at: monotonicNow(), mode, ok: true, reason: '', phase: 'up', toggledOff: true, epoch: actionEpoch });
    else post('action', { actionId, ...action, at: monotonicNow(), mode, ok: false, reason: outcome.reason, epoch: actionEpoch });
  }).catch(error => { logger.write('input.error', { actionId, message: error.message }, 'error'); post('warning', error.message); });
}
function handleRecognition(value, modelId = 'vosk', tick = false) {
  if (enrolling) return;
  if (!value || config.modelId !== modelId || !['partial', 'final'].includes(value.type) || typeof value.text !== 'string' || value.text.length > 300) return;
  if (!armed || !voiceReady || value.epoch !== epoch || monotonicNow() > acceptUntil || !listening && value.type !== 'final') {
    if (!tick) logger.write('recognition.ignored', { type: value.type, text: value.text, receivedEpoch: value.epoch, epoch, armed, listening, voiceReady });
    return;
  }
  const incomingSegment = Number.isInteger(value.segmentId) ? value.segmentId : 0;
  if (incomingSegment < segment || incomingSegment <= finishedSegment) return;
  if (incomingSegment > segment) { segment = incomingSegment; matcher.reset(); wordHypothesis = null; }
  const identity = `${segment}:${value.type}:${value.text}`;
  if (!tick && identity !== lastRecognitionLog) {
    logger.write(`recognition.${value.type}`, { text: value.text, words: value.type === 'final' && Array.isArray(value.words) ? value.words.slice(0, 40) : undefined, epoch, segment, modelId, decodeMs: value.decodeMs });
    lastRecognitionLog = identity;
  }
  if (config.commandMode === 'words' && value.type === 'partial') wordHypothesis = value;
  const decision = matcher.assess(value.text, value.type === 'final', value.words);
  if (value.type === 'final') { finishedSegment = segment; wordHypothesis = null; }
  if (!decision.accepted) {
    if (value.type === 'final') {
      logger.write('recognition.rejected', { text: value.text, reason: decision.reason, confidence: decision.confidence, epoch, segment });
      if (value.text.trim() && decision.reason !== 'no_new_word_command') post('decision', { ...decision, at: monotonicNow() });
    }
    return;
  }
  for (const action of decision.actions || [decision.action]) {
    // with the classifier on, a command it has already pressed (or will press a moment later) is pressed only once
    if (classifierReady && !arbiter.claim('text', actionSignature(action))) { logger.write('classifier.deduped', { by: 'text', phrase: action.phrase, key: action.key }); continue; }
    dispatchAction(action, value);
  }
}
// Models other than Vosk run in a worker thread of this process: T-one streams, GigaAM decodes whole utterances.
async function prepareNative() {
  const id = config.modelId, model = MODELS[id];
  if (!model) throw new Error('Неизвестная модель.');
  if (!modelStatus().installed[id]) throw new Error(`Модель ${CATALOG[id].title} не скачана. Нажмите «Скачать» в «Настройки → Распознавание».`);
  const identity = `${id}:${config.language}:${config.speechEndMs}`;
  if (nativeWorker && nativePrepared === identity) return;
  await nativeWorker?.terminate(); nativePrepared = '';
  const [file, tokens] = modelFiles(MODEL_ROOTS, id);
  const worker = id === 'gigaam'
    ? new Worker(path.join(__dirname, 'gigaam-worker.js'), { workerData: { model: file, tokens } })
    : new Worker(path.join(__dirname, 'sherpa-worker.js'), { workerData: { directory: path.dirname(file), speechEndMs: config.speechEndMs } });
  nativeWorker = worker;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${model.title} не подготовилась за 60 секунд.`)), 60000);
    worker.on('message', message => {
      if (message.type === 'ready') { clearTimeout(timeout); nativePrepared = identity; resolve(); }
      else if (message.type === 'error') { clearTimeout(timeout); logger.write('sherpa.error', message, 'error'); reject(new Error(message.message)); stop('sherpa-error'); post('warning', message.message); }
      else if(message.type==='benchmark-result'){const pending=benchmarkRequests.get(message.requestId);if(pending){clearTimeout(pending.timeout);benchmarkRequests.delete(message.requestId);pending.resolve(message.result);}}
      else if (message.type === 'recognition') { post('transcript', message.value); handleRecognition(message.value, message.value.modelId); }
    });
    worker.once('error', error => { clearTimeout(timeout); reject(error); stop('sherpa-worker-error'); });
  });
}
const engineOpen = () => enrolling || armed && listening;
function installIpc() {
  ipcMain.handle('settings:load', event => {
    if (!trusted(event)) throw new Error('Недопустимый источник.');
    return { config, state: state(), startupWarning, logs: logger.info(), models: modelStatus(), samples:samples.list(config.activeProfileId), data: dataInfo() };
  });
  ipcMain.handle('settings:save', (event, value, options = {}) => {
    if (!trusted(event)) return { ok: false, error: 'Недопустимый источник.' };
    try {
      if(benchmarkBusy)throw new Error('Дождитесь завершения замера.');
      const validated = validateStore(value);
      // live: a command added from the journal while listening must not stop the listener.
      if (options?.live) persist(validated, { keepState: true });
      else { stop('settings-change'); enrolling = false; persist(validated); }
      logger.write('settings.saved', { config, live: Boolean(options?.live) });
      emitState();
      return { ok: true, config };
    } catch (error) {
      logger.write('settings.rejected', { message: error.message }, 'warn');
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('profile:change',(event,value)=>{
    if(!trusted(event))return{ok:false,error:'Недопустимый источник.'};
    try{if(benchmarkBusy)throw new Error('Дождитесь завершения замера.');const next=changeProfile(config,value);stop('profile-change');timeline.items.clear();persist(next);if(value.operation==='delete')classifierStore.removeModel(String(value.id));logger.write('profile.changed',{operation:value.operation,id:next.activeProfileId,name:next.profiles.find(p=>p.id===next.activeProfileId).name});return{ok:true,config,state:state(),samples:samples.list(config.activeProfileId)};}catch(error){return{ok:false,error:error.message};}
  });
  ipcMain.handle('ui:prefs', (event, value) => {
    if (!trusted(event) || !value) return { ok: false, error: 'Недопустимый источник.' };
    try { return { ok: true, config: applyPrefs(value) }; } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.on('voice:onset', (event, at) => { if (trusted(event) && Number.isFinite(at)) lastOnsetAt = at; });
  ipcMain.handle('profiles:export', async event => {
    if (!trusted(event)) return { ok: false };
    const choice = await dialog.showMessageBox(win, { type: 'question', buttons: ['Текущий профиль', 'Все профили', 'Отмена'], cancelId: 2, defaultId: 0, title: 'Экспорт профилей', message: 'Что сохранить в файл?' });
    if (choice.response === 2) return { ok: false, cancelled: true };
    try {
      const scope = choice.response === 1 ? 'all' : 'current', data = exportProfiles(config, scope);
      const name = scope === 'all' ? 'Voice-Keys-все-профили' : `Voice-Keys-${data.profiles[0].name}`.replace(/[\\/:*?"<>|]/g, '_');
      const target = await dialog.showSaveDialog(win, { title: 'Экспорт профилей', defaultPath: `${name}.json`, filters: [{ name: 'Профили Voice Keys', extensions: ['json'] }] });
      if (target.canceled || !target.filePath) return { ok: false, cancelled: true };
      fs.writeFileSync(target.filePath, JSON.stringify(data, null, 2), 'utf8');
      logger.write('profiles.exported', { scope, count: data.profiles.length });
      return { ok: true, count: data.profiles.length, path: target.filePath };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('profiles:import', async event => {
    if (!trusted(event)) return { ok: false };
    if (benchmarkBusy || enrolling) return { ok: false, error: 'Сначала завершите замер или запись.' };
    const source = await dialog.showOpenDialog(win, { title: 'Импорт профилей', properties: ['openFile'], filters: [{ name: 'Профили Voice Keys', extensions: ['json'] }] });
    if (source.canceled || !source.filePaths[0]) return { ok: false, cancelled: true };
    try {
      if (fs.statSync(source.filePaths[0]).size > 2 * 1024 * 1024) throw new Error('Файл слишком большой для профилей.');
      let data; try { data = JSON.parse(fs.readFileSync(source.filePaths[0], 'utf8')); } catch { throw new Error('Файл не читается как JSON.'); }
      const result = importProfiles(config, data);
      stop('profiles-import'); persist(result.store);
      logger.write('profiles.imported', { added: result.added });
      return { ok: true, added: result.added, config, state: state(), samples: samples.list(config.activeProfileId) };
    } catch (error) { logger.write('profiles.import_failed', { message: error.message }, 'warn'); return { ok: false, error: error.message }; }
  });
  ipcMain.handle('overlay:demo',event=>{
    if(!trusted(event))return;const base=-Date.now();for(let i=0;i<3;i++)timeline.enqueue({actionId:base-i,key:i===2?'R':'Q',phrase:'Пример оверлея',actionType:'tap'});updateOverlay();
    for(let i=0;i<3;i++)setTimeout(()=>{if(timeline.items.get(base-i)?.status!=='pending')return;timeline.start(base-i);timeline.finish(base-i,{ok:true});updateOverlay();},700+i*450);
  });
  ipcMain.handle('samples:save',(event,value)=>{
    if(!trusted(event)||armed||benchmarkBusy)return{ok:false,error:'Сначала остановите прослушивание.'};
    try{const result=samples.save({...value,profileId:config.activeProfileId});logger.write('sample.saved',result);return{ok:true,sample:result,samples:samples.list(config.activeProfileId)};}catch(error){return{ok:false,error:error.message};}
  });
  ipcMain.handle('samples:read',(event,id)=>{if(!trusted(event))throw new Error('Недопустимый источник.');return samples.read(id,config.activeProfileId);});
  ipcMain.handle('samples:delete',(event,id)=>{if(!trusted(event)||armed||benchmarkBusy)return{ok:false};try{samples.remove(id,config.activeProfileId);return{ok:true,samples:samples.list(config.activeProfileId)};}catch(error){return{ok:false,error:error.message};}});
  ipcMain.handle('samples:benchmark',async(event,id)=>{
    if(!trusted(event)||armed||benchmarkBusy||config.modelId==='vosk')return{ok:false,error:'Для этого замера остановите прослушивание и выберите T-one или GigaAM.'};
    benchmarkBusy=true;
    try{const sample=samples.read(id,config.activeProfileId);await prepareNative();const requestId=require('node:crypto').randomUUID();const result=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{benchmarkRequests.delete(requestId);reject(new Error('Замер не завершился за 30 секунд.'));},30000);benchmarkRequests.set(requestId,{resolve,timeout});nativeWorker.postMessage({type:'benchmark',requestId,samples:sample.samples,sampleRate:sample.sampleRate});});return{ok:true,...result};}catch(error){return{ok:false,error:error.message};}finally{benchmarkBusy=false;}
  });
  ipcMain.handle('samples:report',(event,value)=>{
    if(!trusted(event)||!value)return;const sample=samples.read(value.id,config.activeProfileId);
    const report={id:sample.id,profileId:config.activeProfileId,expectedText:sample.expectedText,modelId:config.modelId,recognizedText:String(value.recognizedText||'').slice(0,500),audioMs:sample.durationMs,decodeMs:Number(value.decodeMs),engineDecodeMs:Number.isFinite(value.engineDecodeMs)?value.engineDecodeMs:null,firstTextMs:Number(value.firstTextMs),loadMs:Number(value.loadMs),realTimeFactor:Number(value.decodeMs)/sample.durationMs};
    if(!Number.isFinite(report.decodeMs)||report.decodeMs<0||report.decodeMs>120000)throw new Error('Некорректный замер.');logger.write('sample.benchmark',report);return report;
  });
  // Voice enrollment: the recognizer runs for the UI only. Nothing is matched, so no key can be pressed.
  ipcMain.handle('enroll:start', event => {
    if (!trusted(event) || armed || benchmarkBusy) return { ok: false, error: 'Сначала остановите прослушивание.' };
    enrolling = true; epoch++;
    logger.write('enroll.start', { epoch, modelId: config.modelId, language: config.language });
    return { ok: true, epoch };
  });
  ipcMain.handle('enroll:stop', event => {
    if (!trusted(event)) return { ok: false };
    enrolling = false; nativeWorker?.postMessage({ type: 'stop' });
    logger.write('enroll.stop', { epoch }); return { ok: true };
  });
  ipcMain.handle('listen:arm', async (event, enabled) => {
    if (!trusted(event)) return { ok: false };
    if (!enabled) { stop('button'); return { ok: true, state: state() }; }
    if (enrolling) return { ok: false, error: 'Завершите запись произношения.' };
    if (classifierTraining || mlSetupRunning) return { ok: false, error: 'Дождитесь окончания обучения классификатора.' };
    if(benchmarkBusy)return{ok:false,error:'Дождитесь завершения замера.'};
    if (!voiceReady) {
      logger.write('listener.arm_rejected', { reason: 'voice-not-ready' }, 'warn');
      return { ok: false, error: 'Сначала подготовьте микрофон и модель распознавания.' };
    }
    await ensureClassifier();
    armed = true; arbiter.reset();
    logger.write('listener.armed', { language: config.language, outputMode: config.outputMode, listenMode: config.listenMode, holdKey: config.holdKey });
    if (config.listenMode === 'always') setListening(true);
    else emitState();
    return { ok: true, state: state() };
  });
  ipcMain.handle('voice:ready', (event, ready) => {
    if (!trusted(event)) return;
    voiceReady = ready === true;
    logger.write('voice.ready', { ready: voiceReady });
    if (!voiceReady) stop('voice-not-ready');
    emitState();
  });
  ipcMain.handle('engine:prepare', async event => {
    if (!trusted(event)) return { ok: false, error: 'Недопустимый источник.' };
    try { if (config.modelId !== 'vosk') await prepareNative(); return { ok: true, models: modelStatus() }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('model:install', async (event, id) => {
    if (!trusted(event) || armed) return { ok: false, error: 'Сначала остановите прослушивание.' };
    if (!CATALOG[id]) return { ok: false, error: 'Неизвестная модель.' };
    const vosk = /^vosk-(ru|en)$/.exec(id), script = vosk ? ['setup-models.js', vosk[1]] : ['setup-sherpa.js', id];
    const title = CATALOG[id].title;
    try {
      // The archive is downloaded here, through the network stack of the window, which follows the proxy settings of Windows;
      // the script then finds it, unpacks it and checks the result (it also downloads by itself when run from the command line).
      fs.mkdirSync(DOWNLOADED_MODELS, { recursive: true });
      const archive = vosk ? path.join(DOWNLOADED_MODELS, VOSK[vosk[1]].file.replace('.tar.gz', '.zip')) : path.join(DOWNLOADED_MODELS, MODELS[id].directory + '.tar.bz2');
      const url = vosk ? `https://alphacephei.com/vosk/models/${path.basename(archive)}` : `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${path.basename(archive)}`;
      if (!fs.existsSync(archive)) await downloadFile(url, archive, (received, total) => post('model-progress', total ? `Скачиваю «${title}»: ${Math.floor(received / total * 100)}% (${Math.round(received / 1048576)} из ${Math.round(total / 1048576)} МБ)` : `Скачиваю «${title}»: ${Math.round(received / 1048576)} МБ`));
      post('model-progress', `Распаковываю «${title}»…`);
      await new Promise((resolve, reject) => execFile(process.execPath, [path.join(ROOT, 'scripts', script[0]), script[1]], { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VOICE_KEYS_MODELS_DIR: DOWNLOADED_MODELS }, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, error => error ? reject(error) : resolve()));
      logger.write('model.installed', { model: id });
      return { ok: true, models: modelStatus() };
    } catch (error) {
      logger.write('model.install_failed', { message: error.message, model: id }, 'error');
      return { ok: false, error: error.name === 'AbortError' ? 'Загрузка остановилась: от сервера минуту нет данных. Проверьте соединение и прокси.' : error.message, models: modelStatus() };
    }
  });
  ipcMain.on('engine:start', (event, value) => { if (trusted(event) && config.modelId !== 'vosk' && engineOpen() && value.epoch === epoch) nativeWorker?.postMessage({ type: 'start', epoch }); });
  ipcMain.on('engine:finish', (event, value) => { if (trusted(event) && config.modelId !== 'vosk' && armed && value.epoch === epoch) nativeWorker?.postMessage({ type: 'finish', epoch }); });
  ipcMain.on('engine:flush', (event, value) => { if (trusted(event) && config.modelId !== 'vosk' && engineOpen() && value.epoch === epoch) nativeWorker?.postMessage({ type: 'flush', epoch }); });
  // Native microphone capture: the helper streams mono float32 blocks, the page feeds them to the same recognizer path as Chromium audio.
  ipcMain.handle('capture:start', async (event, label) => {
    if (!trusted(event)) return { ok: false, error: 'Недопустимый источник.' };
    capture?.stop();
    const own = capture = createWasapiCapture({ exe: NATIVE_CAPTURE_EXE, onAudio: samples => { if (capture === own) post('capture:audio', samples); }, onEnded: reason => { if (capture !== own) return; capture = null; logger.write('capture.ended', { reason }, 'warn'); post('capture:ended', reason); } });
    try { const header = await own.start(typeof label === 'string' ? label.slice(0, 300) : ''); logger.write('capture.started', header); return { ok: true, ...header }; }
    catch (error) { if (capture === own) capture = null; own.stop(); logger.write('capture.start_failed', { message: error.message }, 'error'); return { ok: false, error: error.message }; }
  });
  ipcMain.handle('capture:stop', event => { if (!trusted(event)) return { ok: false }; capture?.stop(); capture = null; return { ok: true }; });
  // Where the data lives, importing it from another folder, start with Windows.
  const dataInfo = () => ({ dir: DATA, mode: LOCATION.mode, firstRun, version: app.getVersion(), autostartSupported: LOCATION.mode === 'installed', autostart: LOCATION.mode === 'installed' && app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin });
  ipcMain.handle('data:info', event => {
    if (!trusted(event)) return { ok: false };
    const info = dataInfo();
    // the first-run hint is shown once: the configuration file now exists
    if (firstRun && !fs.existsSync(CONFIG)) { try { fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2), 'utf8'); } catch { /* shown again next time */ } }
    return { ok: true, ...info };
  });
  ipcMain.handle('data:open', async event => { if (!trusted(event)) return { ok: false }; const error = await shell.openPath(DATA); return { ok: !error, error }; });
  ipcMain.handle('data:import', async event => {
    if (!trusted(event)) return { ok: false, error: 'Недопустимый источник.' };
    if (armed || benchmarkBusy || classifierTraining || mlSetupRunning) return { ok: false, error: 'Сначала остановите прослушивание и дождитесь конца текущей работы.' };
    const chosen = await dialog.showOpenDialog(win, { title: 'Папка с данными Voice Keys', properties: ['openDirectory'] });
    if (chosen.canceled || !chosen.filePaths[0]) return { ok: false, cancelled: true };
    try {
      const info = inspectData(chosen.filePaths[0]);
      if (!info.found.length) throw new Error('В этой папке нет данных Voice Keys (нужен settings.json, classifier или samples).');
      const answer = await dialog.showMessageBox(win, { type: 'question', buttons: ['Перенести', 'Отмена'], defaultId: 0, cancelId: 1, title: 'Перенос данных', message: 'Перенести данные в эту копию программы?', detail: `Из папки: ${chosen.filePaths[0]}\nБудет скопировано: ${info.found.join(', ')}.\nТекущие настройки заменятся (копия сохранится как settings.json.before-import.json), программа перезапустится.${info.hasPython ? '\nОкружение Python и PyTorch не копируется: установите его кнопкой в разделе классификатора.' : ''}` });
      if (answer.response !== 0) return { ok: false, cancelled: true };
      const result = importData(chosen.filePaths[0], DATA); logger.write('data.imported', { from: chosen.filePaths[0], ...result });
      setTimeout(() => { app.relaunch(); app.quit(); }, 400);
      return { ok: true, ...result };
    } catch (error) { logger.write('data.import_failed', { message: error.message }, 'warn'); return { ok: false, error: error.message }; }
  });
  ipcMain.handle('app:autostart', (event, enabled) => {
    if (!trusted(event) || LOCATION.mode !== 'installed') return { ok: false };
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] }); logger.write('app.autostart', { enabled: Boolean(enabled) });
    return { ok: true, autostart: app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin };
  });
  ipcMain.on('classifier:audio', (event, value) => {
    if (!trusted(event) || !classifierReady || !armed || !listening || value?.epoch !== epoch || !(value.samples instanceof Float32Array) || value.samples.length > 8192 || !Number.isInteger(value.sampleRate) || value.sampleRate < 8000 || value.sampleRate > 192000) return;
    classifierWorker?.postMessage({ type: 'audio', epoch, samples: value.samples, sampleRate: value.sampleRate }, [value.samples.buffer]);
  });
  // Personal command classifier: recordings, training, environment.
  const classifierBusy = () => armed || benchmarkBusy || enrolling;
  ipcMain.handle('classifier:status', event => { if (!trusted(event)) return { ok: false }; const status = classifierStore.status(); return { ok: true, ...status, generalId: GENERAL_ID, profiles: config.profiles.map(profile => ({ id: profile.id, name: profile.name, general: profile.id === GENERAL_ID, words: profileWords(profile, Object.keys(status.words)) })), activeProfileId: config.activeProfileId, running: classifierScope, trainingScope: classifierTraining?.profileId || null, training: Boolean(classifierTraining), setup: mlSetupRunning, mlInstalled: mlSetup.installed(ML_DIR) }; });
  ipcMain.handle('classifier:ml', async event => { if (!trusted(event)) return { ok: false }; mlProbe = await mlSetup.probe(ML_DIR); return { ok: true, ...mlProbe, canInstall: Boolean(mlSetup.findUv() || mlSetup.findPython()) }; });
  ipcMain.handle('classifier:take', (event, word, samples, rate) => {
    if (!trusted(event)) return { ok: false, reason: 'Недопустимый источник.' };
    if (classifierBusy() || classifierTraining) return { ok: false, reason: 'Сначала остановите прослушивание.' };
    if (!mlSetup.installed(ML_DIR)) return { ok: false, reason: 'Сначала установите Python и PyTorch (шаг 1).' };
    try { const result = classifierStore.addTake(word, samples, rate); logger.write('classifier.take', { word, ...result }); return result; } catch (error) { return { ok: false, reason: error.message }; }
  });
  ipcMain.handle('classifier:background', (event, samples, rate) => {
    if (!trusted(event)) return { ok: false, reason: 'Недопустимый источник.' };
    if (classifierBusy() || classifierTraining) return { ok: false, reason: 'Сначала остановите прослушивание.' };
    if (!mlSetup.installed(ML_DIR)) return { ok: false, reason: 'Сначала установите Python и PyTorch (шаг 1).' };
    try { const result = classifierStore.addBackground(samples, rate); logger.write('classifier.background', result); return result; } catch (error) { return { ok: false, reason: error.message }; }
  });
  ipcMain.handle('classifier:remove', (event, value) => {
    if (!trusted(event) || !value || classifierTraining) return { ok: false };
    try {
      const result = value.kind === 'word' ? classifierStore.removeWord(value.word) : value.kind === 'last' ? classifierStore.removeLastTake(value.word) : value.kind === 'background' ? classifierStore.removeBackground() : value.kind === 'model' ? classifierStore.removeModel(scopeOf(value.scope)) : value.kind === 'all' ? classifierStore.removeAll() : { ok: false };
      logger.write('classifier.remove', value); return { ...result, status: classifierStore.status() };
    } catch (error) { return { ok: false, reason: error.message }; }
  });
  ipcMain.handle('classifier:train', (event, request) => {
    const quality = typeof request === 'string' ? request : request?.quality, profileId = typeof request === 'object' && request?.profileId ? String(request.profileId) : GENERAL_ID;
    if (!trusted(event)) return { ok: false, error: 'Недопустимый источник.' };
    if (classifierBusy() || classifierTraining || mlSetupRunning) return { ok: false, error: 'Сначала остановите прослушивание и дождитесь конца текущей работы.' };
    if (!mlSetup.installed(ML_DIR)) return { ok: false, error: 'Сначала установите Python и PyTorch (шаг 1).' };
    const status = classifierStore.status(), plan = trainingPlan(profileId, status.words, config.profiles), scope = plan.scope;
    if (!plan.ok) return { ok: false, error: plan.error };
    const job = startTraining({ dataDir: classifierStore.dir, modelFile: classifierStore.modelPath(scope), words: plan.words, mlDir: ML_DIR, scriptsDir: ML_SCRIPTS, quality, onProgress: progress => post('classifier:progress', progress) });
    job.scope = scope; job.profileId = profileId; classifierTraining = job; logger.write('classifier.train_started', { quality, profileId, scope, engine: job.engine, words: plan.words });
    const trainedTakes = Object.fromEntries(plan.words.map(word => [word, status.words[word]]));
    job.promise.then(result => { classifierStore.saveTakes(scope, trainedTakes); logger.write('classifier.train_done', { engine: result.engine, threshold: result.threshold, seconds: result.seconds, rows: result.rows }); stopClassifier(); post('classifier:done', { ok: true, profileId, scope, ...result, status: classifierStore.status() }); })
      .catch(error => { logger.write('classifier.train_failed', { message: error.message }, 'warn'); post('classifier:done', { ok: false, profileId, scope, error: error.message, status: classifierStore.status() }); })
      .finally(() => { classifierTraining = null; });
    return { ok: true, engine: job.engine, profileId, scope, words: plan.words };
  });
  ipcMain.handle('classifier:profile-words', (event, value) => {
    if (!trusted(event) || !value) return { ok: false, error: 'Недопустимый источник.' };
    if (classifierTraining) return { ok: false, error: 'Дождитесь окончания обучения.' };
    try { const next = changeProfileWords(config, value); persist(next, { keepState: true }); logger.write('classifier.profile_words', { profileId: value.profileId, operation: value.operation, word: value.word }); return { ok: true, config }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('classifier:cancel', event => { if (!trusted(event)) return { ok: false }; classifierTraining?.cancel(); return { ok: true }; });
  ipcMain.handle('classifier:setup', event => {
    if (!trusted(event)) return { ok: false, error: 'Недопустимый источник.' };
    if (mlSetupRunning || classifierTraining) return { ok: false, error: 'Уже идёт работа.' };
    mlSetupRunning = true; logger.write('classifier.setup_started');
    mlSetup.setup({ mlDir: ML_DIR, onLine: line => post('classifier:setup-line', line) })
      .then(info => { mlProbe = info; logger.write('classifier.setup_done', info); post('classifier:setup-done', { ok: true, ...info }); })
      .catch(error => { logger.write('classifier.setup_failed', { message: error.message }, 'warn'); post('classifier:setup-done', { ok: false, error: error.message }); })
      .finally(() => { mlSetupRunning = false; });
    return { ok: true };
  });
  ipcMain.on('engine:stop', event => { if (trusted(event)) nativeWorker?.postMessage({ type: 'stop' }); });
  ipcMain.on('engine:audio', (event, value) => {
    if (!trusted(event) || config.modelId === 'vosk' || !engineOpen() || value?.epoch !== epoch || !(value.samples instanceof Float32Array) || value.samples.length > 4096 || !Number.isInteger(value.sampleRate) || value.sampleRate < 8000 || value.sampleRate > 192000) return;
    nativeWorker?.postMessage({ type: 'audio', epoch, samples: value.samples, sampleRate: value.sampleRate }, [value.samples.buffer]);
  });
  ipcMain.handle('logs:open', async event => {
    if (!trusted(event)) return { ok: false, error: 'Недопустимый источник.' };
    logger.write('logs.opened');
    const error = await shell.openPath(logger.info().directory);
    if (error) logger.write('logs.open_failed', { message: error }, 'error');
    return { ...logger.info(), ok: !error, error };
  });
  const diagnosticEvents = new Set([
    'ui.ready', 'model.loading', 'model.ready', 'microphone.requested', 'microphone.ready',
    'microphone.ended', 'voice.prepare_failed', 'recognizer.started', 'recognizer.finished',
    'test.keydown', 'enroll.heard', 'ui.error', 'ui.unhandled_rejection', 'microphone.list', 'microphone.list_failed', 'microphone.resolved'
  ]);
  ipcMain.on('diagnostic', (event, value) => {
    if (!trusted(event) || !value || !diagnosticEvents.has(value.event)) return;
    logger.write(value.event, { detail: String(value.detail || '').slice(0, 4000) }, value.event.includes('failed') || value.event.includes('error') || value.event.includes('rejection') ? 'error' : 'info');
  });
  ipcMain.on('voice:recognition', (event, value) => { if (trusted(event)) handleRecognition(value); });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.gz': 'application/gzip' };
async function startServer() {
  const files = {
    '/': path.join(ROOT, 'ui', 'index.html'),
    '/app.js': path.join(ROOT, 'ui', 'app.js'),
    '/classifier.js': path.join(ROOT, 'ui', 'classifier.js'),
    '/data.js': path.join(ROOT, 'ui', 'data.js'),
    '/capture-worklet.js': path.join(ROOT, 'ui', 'capture-worklet.js'),
    '/style.css': path.join(ROOT, 'ui', 'style.css'),
    '/core.js': path.join(ROOT, 'src', 'core.js'),
    '/microphones.js': path.join(ROOT, 'src', 'microphones.js'),
    '/overlay':path.join(ROOT,'ui','overlay.html'),'/overlay.css':path.join(ROOT,'ui','overlay.css'),'/overlay.js':path.join(ROOT,'ui','overlay.js'),
    '/vosk.js': require.resolve('vosk-browser/dist/vosk.js'),
    '/model-ru.tar.gz': null, '/model-en.tar.gz': null // found at request time: they are downloaded by the user
  };
  server = http.createServer((req, res) => {
    const file = req.url === '/model-ru.tar.gz' ? voskArchive(MODEL_ROOTS, 'ru') : req.url === '/model-en.tar.gz' ? voskArchive(MODEL_ROOTS, 'en') : files[req.url];
    if (req.method !== 'GET' || !file) { res.writeHead(404); res.end(); return; }
    fs.stat(file, (error, info) => {
      if (error) { logger.write('resource.missing', { resource: req.url, message: error.message }, 'error'); res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': info.size,
        // Vosk's bundled Emscripten worker generates JS functions at runtime.
        // wasm-unsafe-eval alone permits WASM compilation but not those functions.
        'Content-Security-Policy': "default-src 'self'; script-src 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob: data:; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(file).pipe(res);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  logger.write('server.ready', { origin });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    try {
      nativeTheme.themeSource = config.theme;
      native = createNativeInput(inputOptions);
      await startServer();
      session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
        callback(contents === win?.webContents && sameOrigin(contents.getURL(), origin) && permission === 'media' && details.mediaTypes?.every(type => type === 'audio'));
      });
      session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => microphoneCheck({ owner: contents === win?.webContents, permission, requestingOrigin, details, origin }));
      installIpc();
      appIcon = nativeImage.createFromBitmap(drawAppIcon(256), { width: 256, height: 256 });
      win = new BrowserWindow({
        icon: appIcon, show: !startHidden, width: 1160, height: 820, minWidth: 940, minHeight: 660,
        title: 'Voice Keys', backgroundColor: config.theme === 'dark' ? '#181512' : '#f4efe6', autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
      });
      win.setMenu(null);
      win.on('close', event => {
        if (quitting || !config.closeToTray || !tray) return;
        event.preventDefault(); win.hide();
        if (!trayHintShown) { trayHintShown = true; tray.displayBalloon?.({ icon: appIcon, title: 'Voice Keys работает в трее', content: 'Значок у часов: открыть окно, остановить или выйти.', iconType: 'info' }); }
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event, url) => { if (url !== `${origin}/`) event.preventDefault(); });
      win.webContents.on('render-process-gone', (_event, details) => { logger.write('renderer.gone', details, 'error'); voiceReady = false; capture?.stop(); capture = null; stop('renderer-gone'); });
      win.webContents.on('did-fail-load', (_event, code, message, url) => logger.write('renderer.load_failed', { code, message, url }, 'error'));
      win.webContents.on('console-message', (...args) => {
        const message = typeof args[2] === 'string' ? args[2] : args[0]?.message || '';
        const level = typeof args[1] === 'number' ? args[1] : args[0]?.level;
        if (level === 3 || level === 'error') logger.write('renderer.console_error', { message: String(message).replace(/data:[^,\s]+;base64,[A-Za-z0-9+/=]+/g, '[embedded data]').slice(0, 4000) }, 'error');
        const missing = /Ignoring word missing in vocabulary: '(.+?)'/.exec(message);
        if (missing) {
          logger.write('model.unknown_word', { word: missing[1] }, 'warn');
          post('warning', `Модель не знает слово «${missing[1]}». Выберите другое написание или другую фразу.`);
        }
      });
      await win.loadURL(`${origin}/`);
      createTray();
      await createOverlay();
      win.on('closed',()=>{if(overlayWindow&&!overlayWindow.isDestroyed())overlayWindow.close();});
      const hotkeyRegistered = globalShortcut.register('Control+Shift+F8', () => stop('emergency-hotkey'));
      logger.write('hotkey.registered', { accelerator: 'Control+Shift+F8', ok: hotkeyRegistered }, hotkeyRegistered ? 'info' : 'warn');
      if (!hotkeyRegistered) post('warning', 'Ctrl+Shift+F8 занято другой программой. Используйте кнопку «Остановить».');
      tickTimer = setInterval(() => {
        if (armed && voiceReady && config.listenMode === 'hold') setListening(native.isDown(config.holdKey));
        if (armed && listening && config.commandMode === 'words' && wordHypothesis) handleRecognition(wordHypothesis, config.modelId, true);
      }, 20);
    } catch (error) { logger.write('app.start_failed', { message: error.message, stack: error.stack }, 'error'); console.error(error); app.quit(); }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    if (stopping) return;
    stopping = true;
    stop('app-quit'); clearInterval(tickTimer); clearTimeout(finalizeTimer);clearInterval(overlayTimer);
    globalShortcut.unregisterAll(); server?.close(); tray?.destroy();
    nativeWorker?.terminate(); capture?.stop(); classifierTraining?.cancel(); stopClassifier();
    logger.write('app.exit');
  });
}
