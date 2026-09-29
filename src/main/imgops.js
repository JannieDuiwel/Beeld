'use strict';
/**
 * Pure image post-processing for game assets. No network, no Electron, so it is
 * testable on its own. Everything takes/returns PNG Buffers.
 */
const sharp = require('sharp');

async function raw(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}
const toPng = (data, w, h) => sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();

/** Most common colours after coarse bucketing -> palette of n colours. */
function buildPalette(data, n) {
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  // median-cut lite: repeatedly split the box with the widest channel range.
  let boxes = [[...counts.entries()].map(([k, c]) => ({ r: (k >> 10) << 3, g: ((k >> 5) & 31) << 3, b: (k & 31) << 3, c }))];
  while (boxes.length < n) {
    let bi = -1, best = 0, ch = 'r';
    boxes.forEach((bx, i) => {
      if (bx.length < 2) return;
      for (const c of ['r', 'g', 'b']) {
        const v = bx.map((p) => p[c]);
        const range = Math.max(...v) - Math.min(...v);
        if (range * Math.log2(bx.length + 1) > best) { best = range * Math.log2(bx.length + 1); bi = i; ch = c; }
      }
    });
    if (bi < 0) break;
    const bx = boxes[bi].sort((a, b) => a[ch] - b[ch]);
    const total = bx.reduce((s, p) => s + p.c, 0);
    let acc = 0, cut = 1;
    for (let i = 0; i < bx.length - 1; i++) { acc += bx[i].c; if (acc >= total / 2) { cut = i + 1; break; } }
    boxes.splice(bi, 1, bx.slice(0, cut), bx.slice(cut));
  }
  return boxes.filter((b) => b.length).map((bx) => {
    const t = bx.reduce((s, p) => s + p.c, 0);
    return [
      Math.round(bx.reduce((s, p) => s + p.r * p.c, 0) / t),
      Math.round(bx.reduce((s, p) => s + p.g * p.c, 0) / t),
      Math.round(bx.reduce((s, p) => s + p.b * p.c, 0) / t),
    ];
  });
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Snap every opaque pixel to the nearest palette colour, optionally ordered-dithered. */
function applyPalette(data, w, h, palette, dither) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 128) { data[i + 3] = 0; continue; }
    data[i + 3] = 255;
    const bias = dither ? ((BAYER4[(y & 3) * 4 + (x & 3)] / 16) - 0.5) * 48 : 0;
    const r = data[i] + bias, g = data[i + 1] + bias, b = data[i + 2] + bias;
    let bd = Infinity, bp = palette[0];
    for (const p of palette) {
      const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
      if (d < bd) { bd = d; bp = p; }
    }
    data[i] = bp[0]; data[i + 1] = bp[1]; data[i + 2] = bp[2];
  }
}

/**
 * Downscale to a true low-res grid (box average), quantise, return at native
 * resolution. scale>1 upsamples with nearest-neighbour afterwards.
 */
async function pixelate(buf, { width, colors = 16, dither = false, scale = 1, palette } = {}) {
  const meta = await sharp(buf).metadata();
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round((meta.height / meta.width) * w));
  const small = await sharp(buf).ensureAlpha().resize(w, h, { kernel: 'lanczos3', fit: 'fill' }).raw().toBuffer();
  const pal = palette || buildPalette(small, colors);
  applyPalette(small, w, h, pal, dither);
  let out = await toPng(small, w, h);
  if (scale > 1) out = await upscale(out, scale);
  return { png: out, width: w * Math.max(1, scale), height: h * Math.max(1, scale), palette: pal };
}

const upscale = (buf, factor) => sharp(buf).resize({ width: undefined, height: undefined, kernel: 'nearest' }).metadata()
  .then((m) => sharp(buf).resize(m.width * factor, m.height * factor, { kernel: 'nearest' }).png().toBuffer());

/**
 * Background removal for generated sprites: flood-fill from the edges through
 * pixels close to the background colour (auto-detected from the corners).
 * Works for the flat-colour backgrounds we ask the model for; not a matting tool.
 */
async function removeBackground(buf, { tolerance = 40, color } = {}) {
  const { data, w, h } = await raw(buf);
  const px = (x, y) => (y * w + x) * 4;
  let bg = color;
  if (!bg) {
    const cs = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => [data[px(x, y)], data[px(x, y) + 1], data[px(x, y) + 2]]);
    bg = cs.map((c, i) => [c, cs.filter((o) => Math.abs(o[0] - c[0]) + Math.abs(o[1] - c[1]) + Math.abs(o[2] - c[2]) < 30).length])
      .sort((a, b) => b[1] - a[1])[0][0];
  }
  const near = (i) => Math.sqrt((data[i] - bg[0]) ** 2 + (data[i + 1] - bg[1]) ** 2 + (data[i + 2] - bg[2]) ** 2) <= tolerance;
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push([x, 0], [x, h - 1]); }
  for (let y = 0; y < h; y++) { stack.push([0, y], [w - 1, y]); }
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h || seen[y * w + x]) continue;
    if (!near(px(x, y))) continue;
    seen[y * w + x] = 1;
    data[px(x, y) + 3] = 0;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return { png: await toPng(data, w, h), background: bg };
}

async function trim(buf) {
  return sharp(buf).trim({ threshold: 1 }).png().toBuffer().catch(() => buf);
}

/** Grid spritesheet. Frames are fitted (nearest) into a uniform cell. */
async function spritesheet(bufs, { cols, cell, padding = 0 } = {}) {
  const metas = await Promise.all(bufs.map((b) => sharp(b).metadata()));
  const cw = cell?.[0] || Math.max(...metas.map((m) => m.width));
  const ch = cell?.[1] || Math.max(...metas.map((m) => m.height));
  const c = cols || Math.ceil(Math.sqrt(bufs.length));
  const rows = Math.ceil(bufs.length / c);
  const comps = await Promise.all(bufs.map(async (b, i) => ({
    input: await sharp(b).resize(cw, ch, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'nearest' }).png().toBuffer(),
    left: (i % c) * (cw + padding), top: Math.floor(i / c) * (ch + padding),
  })));
  const W = c * cw + (c - 1) * padding, H = rows * ch + (rows - 1) * padding;
  const png = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(comps).png().toBuffer();
  return { png, cols: c, rows, cellW: cw, cellH: ch, width: W, height: H, frames: bufs.length };
}

module.exports = { pixelate, removeBackground, trim, spritesheet, upscale, buildPalette };
