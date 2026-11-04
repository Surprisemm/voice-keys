'use strict';
// Where the app keeps its settings, recordings, models and logs.
//   env      VOICE_KEYS_DATA_DIR (tests, special setups)
//   dev      <project>/data when run from the source folder
//   portable the single portable exe: VoiceKeys-data next to the exe
//   installed everything else: %APPDATA%/Voice Keys (the program folder may be read-only and is replaced on update)
const path = require('node:path');
const fs = require('node:fs');

function resolveDataDir({ env = process.env, isPackaged, appData, execPath, root }) {
  if (env.VOICE_KEYS_DATA_DIR) return { dir: env.VOICE_KEYS_DATA_DIR, mode: 'env' };
  if (!isPackaged) return { dir: path.join(root, 'data'), mode: 'dev' };
  if (env.PORTABLE_EXECUTABLE_DIR) return { dir: path.join(env.PORTABLE_EXECUTABLE_DIR, 'VoiceKeys-data'), mode: 'portable' };
  return { dir: path.join(appData, 'Voice Keys'), mode: 'installed', legacy: path.join(path.dirname(execPath), 'VoiceKeys-data') };
}
// The installed app starts with nothing. Data kept next to the exe by an older build is carried over once.
function legacyToImport(location) {
  if (location.mode !== 'installed' || !location.legacy) return null;
  const hasSettings = folder => fs.existsSync(path.join(folder, 'settings.json'));
  return !hasSettings(location.dir) && hasSettings(location.legacy) ? location.legacy : null;
}
module.exports = { resolveDataDir, legacyToImport };
