'use strict';
// Draws build/icon.ico (the app icon at several sizes) so the release needs no binary assets in the sources.
const fs = require('node:fs');
const path = require('node:path');
const { drawAppIcon } = require('../src/tray-icon');
const SIZES = [16, 32, 48, 64, 128, 256];

// ICO entry in BMP (DIB) form: BITMAPINFOHEADER, bottom-up BGRA pixels, empty AND mask.
function dib(size) {
  const bgra = drawAppIcon(size), header = Buffer.alloc(40), rows = Buffer.alloc(size * size * 4);
  header.writeUInt32LE(40, 0); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8); header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);
  // The bitmap holds premultiplied colour; DIB wants straight alpha.
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const from = (y * size + x) * 4, to = ((size - 1 - y) * size + x) * 4, alpha = bgra[from + 3];
    for (let channel = 0; channel < 3; channel++) rows[to + channel] = alpha ? Math.min(255, Math.round(bgra[from + channel] * 255 / alpha)) : 0;
    rows[to + 3] = alpha;
  }
  return Buffer.concat([header, rows, Buffer.alloc(Math.ceil(size / 32) * 4 * size)]);
}
function build() {
  const images = SIZES.map(dib), directory = Buffer.alloc(6 + SIZES.length * 16);
  directory.writeUInt16LE(1, 2); directory.writeUInt16LE(SIZES.length, 4);
  let offset = directory.length;
  SIZES.forEach((size, index) => {
    const at = 6 + index * 16;
    directory[at] = size === 256 ? 0 : size; directory[at + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, at + 4); directory.writeUInt16LE(32, at + 6); directory.writeUInt32LE(images[index].length, at + 8); directory.writeUInt32LE(offset, at + 12);
    offset += images[index].length;
  });
  return Buffer.concat([directory, ...images]);
}
if (require.main === module) {
  const target = path.join(__dirname, '..', 'build', 'icon.ico');
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, build()); console.log(`${target} written`);
}
module.exports = { build };
