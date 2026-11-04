'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Models that run in the main process through sherpa-onnx (Vosk runs in the window and is not listed).
const MODELS = {
  sherpa: {
    title: 'T-one', directory: 'sherpa-onnx-streaming-t-one-russian-2025-09-08', sizeMb: 130,
    files: [/^model\.onnx$/, /^tokens\.txt$/]
  },
  gigaam: {
    title: 'GigaAM v3', directory: 'sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16', sizeMb: 163,
    files: [/^model(\.int8)?\.onnx$/, /^tokens\.txt$/]
  }
};
// Returns the real file names of a model directory, or null while something is missing.
// `roots` is one folder or several (bundled models first, then the ones downloaded into the data folder).
function modelFiles(roots, id) {
  const model = MODELS[id]; if (!model) return null;
  for (const root of [].concat(roots)) {
    let names; try { names = fs.readdirSync(path.join(root, model.directory)); } catch { continue; }
    const found = model.files.map(pattern => names.find(name => pattern.test(name)));
    if (found.every(Boolean)) return found.map(name => path.join(root, model.directory, name));
  }
  return null;
}
const modelFilesReady = (root, id) => Boolean(modelFiles(root, id));

// Vosk models run in the window; the app serves their archives.
const VOSK = { ru: { id: 'vosk-ru', file: 'vosk-model-small-ru-0.22.tar.gz' }, en: { id: 'vosk-en', file: 'vosk-model-small-en-us-0.15.tar.gz' } };
function voskArchive(roots, language) {
  const entry = VOSK[language]; if (!entry) return null;
  for (const root of [].concat(roots)) { const file = path.join(root, entry.file); try { if (fs.statSync(file).size > 1000000) return file; } catch { /* not here */ } }
  return null;
}
// What the user is told before a download. None of the models is part of the program or of its repository: each is downloaded from its author.
const CATALOG = {
  'vosk-ru': { title: 'Vosk Small · русский', license: 'Apache 2.0', author: 'Alpha Cephei (Vosk)', source: 'alphacephei.com/vosk/models', sizeMb: 45 },
  'vosk-en': { title: 'Vosk Small · English', license: 'Apache 2.0', author: 'Alpha Cephei (Vosk)', source: 'alphacephei.com/vosk/models', sizeMb: 40 },
  gigaam: { title: 'GigaAM v3 · русский', license: 'MIT', author: 'SberDevices, в формате sherpa-onnx', source: 'github.com/k2-fsa/sherpa-onnx (релиз asr-models)', sizeMb: MODELS.gigaam.sizeMb },
  sherpa: { title: 'T-one Streaming · русский', license: 'Apache 2.0', author: 'T-Technologies, в формате sherpa-onnx', source: 'github.com/k2-fsa/sherpa-onnx (релиз asr-models)', sizeMb: MODELS.sherpa.sizeMb }
};
// which catalog entry a model choice needs: the Vosk choice depends on the language
const catalogId = (modelId, language) => modelId === 'vosk' ? VOSK[language]?.id || 'vosk-ru' : modelId;
module.exports = { MODELS, VOSK, CATALOG, catalogId, voskArchive, modelFiles, modelFilesReady };
