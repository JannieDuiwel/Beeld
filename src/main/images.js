'use strict';
/**
 * Input preparation and output saving.
 *
 * Resizing uses Electron's nativeImage rather than sharp: sharp is a native
 * dependency that needs rebuilding per Electron version and would make this the
 * only thing in the project that can fail to install. nativeImage is already in
 * the process, does bilinear resize, and is entirely good enough for shrinking
 * a screenshot before upload.
 *
 * Why downscale at all: providers take file inputs as base64 data URIs, and
 * base64 inflates by ~33%. A 20 MB SketchUp export becomes a 27 MB string that
 * uploads slowly and may be rejected outright - while the models cap out around
 * 1440px anyway, so the pixels were never going to be used.
 */

const fs = require('fs');
const path = require('path');

const INPUT_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

let nativeImage = null;

function init(ni) {
  nativeImage = ni;
  return module.exports;
}

function isSupported(file) {
  return INPUT_EXT.has(path.extname(file).toLowerCase());
}

/**
 * Loads an image, shrinks its long edge to `maxEdge`, and returns both a PNG
 * buffer (for ComfyUI's multipart upload) and a data URI (for the HTTP APIs).
 */
function prepareInput(file, maxEdge = 1536) {
  if (!isSupported(file)) {
    throw new Error(`Unsupported image type: ${path.extname(file) || 'no extension'}`);
  }
  let img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error(`Could not read that image: ${path.basename(file)}`);

  const size = img.getSize();
  const long = Math.max(size.width, size.height);
  let resized = false;

  if (long > maxEdge) {
    const scale = maxEdge / long;
    img = img.resize({
      width: Math.round(size.width * scale),
      height: Math.round(size.height * scale),
      quality: 'best',
    });
    resized = true;
  }

  const png = img.toPNG();
  return {
    buffer: png,
    dataUri: `data:image/png;base64,${png.toString('base64')}`,
    width: img.getSize().width,
    height: img.getSize().height,
    originalWidth: size.width,
    originalHeight: size.height,
    resized,
    bytes: png.length,
  };
}

/** Makes a filesystem-safe, recognisable stem out of the prompt. */
function slug(prompt, max = 48) {
  const s = String(prompt || 'render')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return s || 'render';
}

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Writes results to disk, never overwriting an existing file. */
function saveAll(images, dir, prompt) {
  fs.mkdirSync(dir, { recursive: true });
  const stem = `${timestamp()}-${slug(prompt)}`;
  const paths = [];

  images.forEach((img, i) => {
    const suffix = images.length > 1 ? `-${i + 1}` : '';
    let file = path.join(dir, `${stem}${suffix}.${img.ext}`);
    let n = 2;
    while (fs.existsSync(file)) file = path.join(dir, `${stem}${suffix}-${n++}.${img.ext}`);
    fs.writeFileSync(file, img.data);
    paths.push(file);
  });

  return paths;
}

function toDataUri(image) {
  const mime = image.ext === 'jpg' ? 'jpeg' : image.ext;
  return `data:image/${mime};base64,${image.data.toString('base64')}`;
}

module.exports = { init, isSupported, prepareInput, saveAll, toDataUri, slug, timestamp, INPUT_EXT };
