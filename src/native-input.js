'use strict';
const koffi = require('koffi');
const { KEYS } = require('./core');
const { createKeyController } = require('./key-controller');

const SPECIAL = {
  SPACE: 0x20, TAB: 0x09, ENTER: 0x0d, ESCAPE: 0x1b, BACKSPACE: 0x08,
  DELETE: 0x2e, INSERT: 0x2d, HOME: 0x24, END: 0x23, PAGEUP: 0x21, PAGEDOWN: 0x22,
  UP: 0x26, DOWN: 0x28, LEFT: 0x25, RIGHT: 0x27,
  NUMADD: 0x6b, NUMSUBTRACT: 0x6d, NUMMULTIPLY: 0x6a, NUMDIVIDE: 0x6f, NUMDECIMAL: 0x6e,
  CTRL: 0x11, SHIFT: 0x10, ALT: 0x12,
  '-': 0xbd, '=': 0xbb, '[': 0xdb, ']': 0xdd, ';': 0xba, "'": 0xde,
  ',': 0xbc, '.': 0xbe, '/': 0xbf, '\\': 0xdc, '`': 0xc0
};
// Mouse buttons: SendInput flags for press/release, XBUTTON id in mouseData, VK for the physical-state check.
const MOUSE_BUTTONS = {
  MOUSE_LEFT: { down: 0x2, up: 0x4, vk: 0x01 }, MOUSE_RIGHT: { down: 0x8, up: 0x10, vk: 0x02 }, MOUSE_MIDDLE: { down: 0x20, up: 0x40, vk: 0x04 },
  MOUSE_X1: { down: 0x80, up: 0x100, vk: 0x05, data: 1 }, MOUSE_X2: { down: 0x80, up: 0x100, vk: 0x06, data: 2 }
};
// One wheel notch is 120 units. Horizontal wheel uses its own flag.
const WHEEL = { WHEEL_UP: { flag: 0x800, data: 120 }, WHEEL_DOWN: { flag: 0x800, data: -120 }, WHEEL_RIGHT: { flag: 0x1000, data: 120 }, WHEEL_LEFT: { flag: 0x1000, data: -120 } };
function vkOf(key) {
  if (MOUSE_BUTTONS[key]) return MOUSE_BUTTONS[key].vk;
  if (WHEEL[key]) return undefined;
  if (/^[A-Z0-9]$/.test(key)) return key.charCodeAt(0);
  if (/^F\d+$/.test(key)) return 0x6f + Number(key.slice(1));
  if (/^NUM\d$/.test(key)) return 0x60 + Number(key.slice(3));
  return SPECIAL[key];
}

function createNativeInput(options = {}) {
  if (process.platform !== 'win32') throw new Error('Отправка клавиш поддерживается только в Windows.');
  const user32 = koffi.load('user32.dll');
  const getAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int vKey)');
  const mapVirtualKey = user32.func('uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)');
  const INPUT = koffi.struct('VK_INPUT', {
    type: 'uint32',
    // x64 INPUT union is aligned to 8 and is 32 bytes long.
    _align: 'uint32',
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32',
    _keyAlign: 'uint32', dwExtraInfo: 'uintptr_t', _pad: koffi.array('uint8', 8)
  });
  if (koffi.sizeof(INPUT) !== 40) throw new Error('Нужна 64-битная версия Windows и Node.js.');
  const sendInput = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int']);
  const MOUSE_INPUT = koffi.struct('VK_MOUSE_INPUT', {
    type: 'uint32', _align: 'uint32', dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', _pad: 'uint32', dwExtraInfo: 'uintptr_t'
  });
  if (koffi.sizeof(MOUSE_INPUT) !== 40) throw new Error('Нужна 64-битная версия Windows и Node.js.');
  const sendMouse = user32.func('uint32 __stdcall SendInput(uint32 cInputs, VK_MOUSE_INPUT *pInputs, int cbSize)');
  const isDown = key => { const vk = vkOf(key); return vk !== undefined && Boolean(getAsyncKeyState(vk) & 0x8000); };
  // Modifiers held by this program are excluded: they would otherwise block our own next command.
  const modifiersDown = (exclude = []) => [['SHIFT', 0x10], ['CTRL', 0x11], ['ALT', 0x12], ['', 0x5b], ['', 0x5c]]
    .some(([name, vk]) => !exclude.includes(name) && getAsyncKeyState(vk) & 0x8000);

  function mouseEdge(key, up) {
    const base = { type: 0, _align: 0, dx: 0, dy: 0, mouseData: 0, dwFlags: 0, time: 0, _pad: 0, dwExtraInfo: 0x564b4559 };
    if (WHEEL[key]) {
      if (up) return true;
      return sendMouse(1, [{ ...base, mouseData: WHEEL[key].data >>> 0, dwFlags: WHEEL[key].flag }], 40) === 1;
    }
    const button = MOUSE_BUTTONS[key];
    return sendMouse(1, [{ ...base, mouseData: button.data || 0, dwFlags: up ? button.up : button.down }], 40) === 1;
  }
  function edge(key, up) {
    if (MOUSE_BUTTONS[key] || WHEEL[key]) return mouseEdge(key, up);
    const scan = mapVirtualKey(vkOf(key), 4);
    const data = {
      type: 1, _align: 0, wVk: 0, wScan: scan & 0xff,
      dwFlags: 0x8 | (scan & 0xff00 ? 0x1 : 0) | (up ? 0x2 : 0),
      time: 0, _keyAlign: 0, dwExtraInfo: 0x564b4559, _pad: Array(8).fill(0)
    };
    return sendInput(1, [data], 40) === 1;
  }
  const controller = createKeyController({ down: key => edge(key, false), up: key => edge(key, true), isDown, modifiersDown }, options);
  return { isDown, perform: controller.perform, tap: (key, durationMs = 65) => controller.perform({ key, durationMs }), release: controller.cancelAll, activeKeys: controller.activeKeys };
}
module.exports = { createNativeInput, vkOf, MOUSE_BUTTONS, WHEEL };
