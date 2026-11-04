'use strict';
// "Данные и запуск": where the data lives, moving it from another folder, start with Windows.
(() => {
  const el = id => document.getElementById(id);
  const WHERE = { installed: 'Установленная версия хранит всё здесь', portable: 'Портативная версия хранит всё рядом с exe', dev: 'Версия из папки проекта хранит всё здесь', env: 'Папка данных задана переменной окружения' };
  async function boot() {
    if (!el('data-panel')) return;
    const info = await window.voiceKeys.dataInfo(); if (!info.ok) return;
    if (el('version-note')) el('version-note').textContent = `Voice Keys · ${info.version}`;
    el('data-where').textContent = `${WHERE[info.mode] || 'Папка данных'}: ${info.dir}. Там настройки, профили, записи голоса, классификатор и журнал.`;
    el('data-version').textContent = `Версия ${info.version}.${info.mode === 'installed' ? ' При удалении программы папку данных можно стереть флажком «Удалить данные».' : ''}`;
    el('autostart').checked = info.autostart; el('autostart-label').hidden = !info.autostartSupported;
    el('data-open').onclick = () => window.voiceKeys.dataOpen();
    el('data-import').onclick = async () => {
      const result = await window.voiceKeys.dataImport();
      if (result.ok) notice('Данные перенесены, программа перезапускается…', true);
      else if (!result.cancelled) notice(result.error || 'Не удалось перенести данные.');
    };
    el('autostart').onchange = async () => { const result = await window.voiceKeys.setAutostart(el('autostart').checked); if (result.ok) el('autostart').checked = result.autostart; };
    // a fresh installed copy: point the user at the import in case an older version had their settings
    if (info.mode === 'installed' && info.firstRun) { el('data-panel').open = true; notice('Первый запуск установленной версии. Если вы пользовались другой копией программы, перенесите её данные: Настройки → Данные и запуск.', true); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0)); else setTimeout(boot, 0);
})();
