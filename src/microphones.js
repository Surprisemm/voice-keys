'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VoiceKeysMicrophones = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const stripDefault = label => String(label || '').replace(/^(default|communications|по умолчанию|устройство связи)\s*[-—:]\s*/i, '');
  function microphoneOptions(devices, selectedId = '', savedLabel = '', active = {}) {
    const inputs = devices.filter(device => device.kind === 'audioinput');
    const defaultDevice = inputs.find(device => device.deviceId === 'default');
    const defaultName = stripDefault(defaultDevice?.label || (!selectedId ? active.label : ''));
    const options = [{ id: '', label: defaultName ? `По умолчанию — ${defaultName}` : 'По умолчанию в Windows', rawLabel: '', missing: false }];
    const seen = new Set(['', 'default', 'communications']);
    let index = 0;
    for (const device of inputs) {
      if (seen.has(device.deviceId)) continue;
      seen.add(device.deviceId); index++;
      const name = device.label || (device.deviceId === active.id ? stripDefault(active.label) : '');
      options.push({ id: device.deviceId, label: name || `Аудиовход ${index} · обновите названия`, rawLabel: name, missing: false });
    }
    let resolvedId = selectedId;
    if (selectedId && !options.some(option => option.id === selectedId)) {
      // Chromium salts IDs per origin. Match the persisted Windows label after a restart.
      const matches = savedLabel ? options.filter(option => option.id && option.rawLabel === savedLabel) : [];
      if (matches.length === 1) resolvedId = matches[0].id;
      else options.push({ id: selectedId, label: `Недоступен — ${savedLabel || 'ранее выбранный микрофон'}`, rawLabel: savedLabel, missing: true });
    }
    return { options, selectedId: resolvedId };
  }
  return { microphoneOptions, stripDefault };
});
