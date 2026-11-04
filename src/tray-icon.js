'use strict';
// The one Voice Keys icon: green rounded square with a white dot. It is drawn in code, so the app ships no image files,
// and the same drawing is used for the exe (build/icon.ico), the tray, the window and the notification balloon.
// Only the tray swaps the green for grey while the app is not listening.
// Returns a premultiplied BGRA bitmap, the format nativeImage.createFromBitmap expects.
const GREEN = [0x1f, 0x9d, 0x6b], GREY = [0x8a, 0x94, 0x8d];
const clamp01 = value => Math.max(0, Math.min(1, value));
function drawAppIcon(size = 32, color = GREEN) {
  const [red, green, blue] = color, bitmap = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2, half = size / 2 - 1, radius = size * 0.24, dotRadius = size * 0.2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const qx = Math.abs(x - center) - (half - radius), qy = Math.abs(y - center) - (half - radius);
    const distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
    const alpha = clamp01(0.5 - distance), glyph = clamp01(0.5 - (Math.hypot(x - center, y - center) - dotRadius));
    const offset = (y * size + x) * 4, mix = channel => (channel * (1 - glyph) + 255 * glyph) * alpha;
    bitmap[offset] = Math.round(mix(blue)); bitmap[offset + 1] = Math.round(mix(green)); bitmap[offset + 2] = Math.round(mix(red)); bitmap[offset + 3] = Math.round(alpha * 255);
  }
  return bitmap;
}
// The same picture as SVG for the page header and the favicon (corner radius 24 and dot radius 20 of 100 match 0.24 and 0.2 of the bitmap size above).
const APP_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="24" fill="#1f9d6b"/><circle cx="50" cy="50" r="20" fill="#fff"/></svg>';
module.exports = { drawAppIcon, APP_ICON_SVG, GREEN, GREY };
