'use strict';
// Builds the release: icon, the native WASAPI helper, then the installer and the portable exe (electron-builder), plus release/README.txt.
//   npm run pack
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..'), release = path.join(root, 'release');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const run = (script, args = []) => execFileSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });

run(path.join(__dirname, 'make-icon.js'));
run(path.join(__dirname, 'build-native.js'));
fs.rmSync(path.join(release, 'win-unpacked'), { recursive: true, force: true });
run(path.join(root, 'node_modules', 'electron-builder', 'cli.js'), ['--win', 'nsis', 'portable']);

// the unpacked folder is only a build step (use `npm run pack:dir` when it is wanted for testing); the leftovers of the builder are noise
for (const leftover of ['win-unpacked', 'builder-debug.yml', 'builder-effective-config.yaml']) fs.rmSync(path.join(release, leftover), { recursive: true, force: true });
for (const name of fs.readdirSync(release)) if (name.endsWith('.blockmap')) fs.rmSync(path.join(release, name), { force: true });

fs.writeFileSync(path.join(release, 'README.txt'), `Voice Keys ${version} — Windows 10/11 x64. Node.js, Python и интернет для работы не нужны.

Что запускать
  Voice-Keys-Setup-${version}.exe        установщик (рекомендуется). Ставится для всех пользователей в
                                         C:\\Program Files\\Voice Keys (Windows спросит разрешение администратора),
                                         папку можно выбрать. Перед установкой мастер спрашивает, создавать ли ярлык на
                                         рабочем столе и в меню «Пуск». Запускается за 1-2 секунды. Новый установщик
                                         ставится поверх старой версии, настройки и записи сохраняются.
                                         В папке программы есть ярлык «Удалить Voice Keys»: деинсталлятор спрашивает,
                                         удалять ли данные.
  Voice-Keys-${version}-portable.exe     один файл без установки (флешка, пробный запуск). При каждом запуске
                                         распаковывается во временную папку, окно появляется через 10-15 секунд.

Где хранятся данные
  Установленная версия:  %APPDATA%\\Voice Keys   (стирается только флажком «Удалить данные» в деинсталляторе)
  Portable:              папка VoiceKeys-data рядом с exe
  Там настройки, профили, записи голоса, классификатор и журнал. Перенести данные из другой папки
  (например, из старой копии): Настройки → «Данные и запуск» → «Перенести данные из другой папки…».

Модели распознавания речи
  В программу и в репозиторий не входят: скачиваются внутри приложения кнопкой «Скачать» рядом с выбором модели
  (с указанием лицензии и источника). GigaAM v3 (MIT, 163 МБ), Vosk Small RU/EN (Apache 2.0, около 45 и 40 МБ),
  T-one (Apache 2.0, 130 МБ). Для первого запуска нужен интернет; после скачивания модель работает без него.

Свой классификатор голоса
  Обучение использует Python и PyTorch (около 2 ГБ с видеокартой NVIDIA, один раз). Установка — кнопкой в разделе
  «Свой классификатор голоса». Для работы уже обученной модели они не нужны.

Замечания
  Сборка не подписана: Windows SmartScreen может предупредить о неизвестном издателе («Подробнее» → «Выполнить в любом
  случае»). Антивирус может проверять программу дольше обычного, особенно помощника native\\WasapiCapture.exe;
  при ложном срабатывании добавьте папку программы в исключения.
`, 'utf8');
console.log('Готово: release/');
