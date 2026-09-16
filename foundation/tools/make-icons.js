'use strict';
/**
 * Generates the app icons as PNGs, so the repo carries no binary blobs and
 * `npm install` always produces them.
 *
 * Hand-rolled PNG encoding rather than an image dependency: for solid blocks
 * and a simple glyph it is a few dozen lines of zlib + CRC32, and it means the
 * artwork is tweaked by editing numbers rather than opening an editor.
 *
 * Replace `icon()` with your own shape. It is called per pixel and returns
 * [r, g, b]; `size` is the canvas edge so the maths can stay resolution
 * independent.
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
 * Placeholder mark: a rounded square with a notch out of one corner. Legible at
 * 16px, which is the only real constraint on an app icon.
 */
function icon(x, y, size) {
  const u = size / 32;              // design on a 32-unit grid
  const gx = x / u, gy = y / u;

  // Rounded square, inset from the edges so it does not touch the tile border.
  const inset = 6, r = 5;
  const cx = Math.min(Math.max(gx, inset + r), 32 - inset - r);
  const cy = Math.min(Math.max(gy, inset + r), 32 - inset - r);
  const d = Math.hypot(gx - cx, gy - cy);
  if (d > r) return BG;

  // Diagonal band across the face.
  const band = gx + gy;
  if (band > 28 && band < 34) return FG2;
  return FG;
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [512, 256, 64]) {
  const name = size === 512 ? 'icon-512.png' : size === 64 ? 'tray.png' : 'icon.png';
  fs.writeFileSync(path.join(OUT, name), png(size, icon));
}
console.log('icons written to src/assets');
