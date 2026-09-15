// Generates media/icon.png (128x128) without any image dependencies.
// Draws the same pi glyph used by media/pi.svg on a rounded indigo tile.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 128;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const px = Buffer.alloc(SIZE * SIZE * 4);

function setPixel(x, y, [r, g, b, a], alpha = 1) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || alpha <= 0) return;
  const i = (y * SIZE + x) * 4;
  const src = alpha;
  const dst = px[i + 3] / 255;
  const out = src + dst * (1 - src);
  if (out <= 0) return;
  px[i] = Math.round((r * src + px[i] * dst * (1 - src)) / out);
  px[i + 1] = Math.round((g * src + px[i + 1] * dst * (1 - src)) / out);
  px[i + 2] = Math.round((b * src + px[i + 2] * dst * (1 - src)) / out);
  px[i + 3] = Math.round(out * 255);
}

function fillRoundRect(x0, y0, w, h, radius, color) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  const r = Math.min(radius, w / 2, h / 2);
  for (let y = Math.floor(y0) - 1; y <= Math.ceil(y1) + 1; y++) {
    for (let x = Math.floor(x0) - 1; x <= Math.ceil(x1) + 1; x++) {
      // Signed distance to the rounded rectangle, used to antialias edges.
      const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy) - r;
      const coverage = Math.min(1, Math.max(0, 0.5 - dist));
      if (coverage > 0) setPixel(x, y, color, coverage);
    }
  }
}

const TILE = [124, 92, 255, 255];
const GLYPH = [255, 255, 255, 255];

// Rounded tile with a subtle vertical lightening.
fillRoundRect(4, 4, SIZE - 8, SIZE - 8, 28, TILE);
for (let y = 4; y < SIZE - 4; y++) {
  const t = (y - 4) / (SIZE - 8);
  const alpha = 0.10 * (1 - t);
  for (let x = 4; x < SIZE - 4; x++) setPixel(x, y, [255, 255, 255, 255], alpha);
}

// Pi glyph: top bar + two legs.
fillRoundRect(26, 38, 76, 13, 5, GLYPH);
fillRoundRect(40, 51, 12, 42, 5, GLYPH);
fillRoundRect(77, 51, 12, 42, 5, GLYPH);

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.join(root, 'media'), { recursive: true });
fs.writeFileSync(path.join(root, 'media', 'icon.png'), png);
console.log(`wrote media/icon.png (${png.length} bytes)`);
