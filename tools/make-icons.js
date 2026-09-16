'use strict';
/**
 * Generates the app icon as a PNG, so the repo does not carry binary assets
 * and `npm install` always produces one. Same approach as Vloei.
 *
 * Hand-rolled PNG encoding rather than a dependency: we only ever need solid
 * blocks and a simple glyph, which is a few dozen lines of zlib + CRC.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'src', 'assets');

const BG = [0x12, 0x13, 0x1a];
const FG = [0x6e, 0xa8, 0xfe];
const FG2 = [0x6e, 0xe7, 0xa8];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, draw) {
  // One filter byte (0 = none) per row, then RGB triples.
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = draw(x, y, size);
      const o = y * stride + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: truecolour
  // 10..12 stay 0: deflate, adaptive filtering, no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A picture frame with a horizon and a sun: legible at 16px, and says "image"
 * without needing text.
 */
function icon(x, y, size) {
  const u = size / 32;                   // design on a 32-unit grid
  const gx = x / u, gy = y / u;

  const inFrame = gx >= 6 && gx <= 26 && gy >= 7 && gy <= 25;
  const onFrame = inFrame && (gx <= 7.5 || gx >= 24.5 || gy <= 8.5 || gy >= 23.5);
  if (onFrame) return FG;

  if (inFrame) {
    // Horizon line with a hill, and a sun above it.
    const hill = 19 + Math.sin((gx - 6) / 3.2) * 1.6;
    if (gy > hill) return FG2;
    const dx = gx - 19.5, dy = gy - 12.5;
    if (dx * dx + dy * dy < 6.5) return FG2;
    return [0x1a, 0x1c, 0x26];
  }

  return BG;
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [512, 256, 64]) {
  const name = size === 512 ? 'icon-512.png' : size === 64 ? 'tray.png' : 'icon.png';
  fs.writeFileSync(path.join(OUT, name), png(size, icon));
}
console.log('icons written to src/assets');
