'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// usage: node scripts/setup-models.js [ru|en]   (no argument: both). The app passes VOICE_KEYS_MODELS_DIR for its own download.
const directory = process.env.VOICE_KEYS_MODELS_DIR || path.resolve(__dirname, '..', 'models');
const names = ['vosk-model-small-ru-0.22', 'vosk-model-small-en-us-0.15'], only = process.argv[2];
async function main() {
  fs.mkdirSync(directory, { recursive: true });
  for (const name of names.filter(item => !only || item.includes(`-${only}-`))) {
    const target = path.join(directory, `${name}.tar.gz`);
    if (fs.existsSync(target) && fs.statSync(target).size > 1000000) continue;
    const zip = path.join(directory, `${name}.zip`);
    if (!fs.existsSync(zip)) { // the app downloads the archive itself and leaves it here
      console.log(`Загружаю ${name} с alphacephei.com...`);
      const response = await fetch(`https://alphacephei.com/vosk/models/${name}.zip`, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error(`Не удалось загрузить модель: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(zip + '.part'));
      fs.renameSync(zip + '.part', zip);
    }
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-xf', zip], { cwd: directory });
    execFileSync(tar, ['-czf', target + '.part', name], { cwd: directory });
    fs.renameSync(target + '.part', target);
    fs.unlinkSync(zip);
    const expanded = path.resolve(directory, name);
    if (path.dirname(expanded) !== directory || !names.includes(path.basename(expanded))) throw new Error('Недопустимая папка модели.');
    fs.rmSync(expanded, { recursive: true });
    console.log(`${name}: готово.`);
  }
  console.log('Готово. Распознавание работает без интернета.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
