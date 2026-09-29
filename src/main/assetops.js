'use strict';
/**
 * Game-asset operations behind the Tools bar (and shared in spirit with the MCP
 * server). Plain Node - no Electron - so the tests can drive it directly.
 *
 * Every op takes a "source" ({ path } or { dataUri }), writes its result into
 * the Assets folder and returns the PNG both as a file and as a data URI, so
 * the UI can chain ops: generate -> cut out -> pixelate -> export.
 */
const fs = require('fs');
const path = require('path');
const ops = require('./imgops');

const hex = (h) => {
  const n = parseInt(String(h).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const slug = (s) => String(s || 'asset').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 48);
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14);

function read(source) {
  // The UI sends both; the data URI is exactly what the user is looking at and
  // survives the file having been moved or deleted since.
  if (source?.dataUri) return Buffer.from(String(source.dataUri).split(',')[1] || '', 'base64');
  if (source?.path) return fs.readFileSync(source.path);
  throw new Error('No image to work on.');
}

function stemOf(source) {
  return source?.path ? path.parse(source.path).name.replace(/_(px|cut|sheet)\w*$/, '') : 'asset';
}

function save(dir, stem, tag, png) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug(stem)}_${tag}_${stamp()}.png`);
  fs.writeFileSync(file, png);
  return file;
}

const dataUri = (png) => `data:image/png;base64,${png.toString('base64')}`;

async function run(op, { source, sources, options = {} }, assetsDir) {
  if (op === 'pixelate') {
    const width = Math.round(Number(options.width) || 32);
    const r = await ops.pixelate(read(source), {
      width,
      colors: Number(options.colors) || 16,
      dither: Boolean(options.dither),
      scale: Number(options.scale) || 1,
      palette: options.palette?.length ? options.palette.map(hex) : undefined,
    });
    const file = save(assetsDir, stemOf(source), `px${width}`, r.png);
    return { ok: true, path: file, dataUri: dataUri(r.png), info: `${r.width}×${r.height}px, ${r.palette.length} colours` };
  }

  if (op === 'cutout') {
    const r = await ops.removeBackground(read(source), {
      tolerance: options.tolerance != null ? Number(options.tolerance) : 40,
      color: options.color ? hex(options.color) : undefined,
    });
    const png = options.trim === false ? r.png : await ops.trim(r.png);
    const file = save(assetsDir, stemOf(source), 'cut', png);
    return { ok: true, path: file, dataUri: dataUri(png), info: `background rgb(${r.background.join(',')}) removed` };
  }

  if (op === 'sheet') {
    if (!sources?.length) throw new Error('Add at least one frame to the tray first.');
    const r = await ops.spritesheet(sources.map(read), {
      cols: Number(options.cols) || undefined,
      cell: options.cellW && options.cellH ? [Number(options.cellW), Number(options.cellH)] : undefined,
      padding: Number(options.padding) || 0,
    });
    const file = save(assetsDir, options.name || 'sheet', 'sheet', r.png);
    const meta = { hframes: r.cols, vframes: r.rows, cell: [r.cellW, r.cellH], frames: r.frames, size: [r.width, r.height] };
    fs.writeFileSync(file.replace(/\.png$/, '.json'), JSON.stringify(meta, null, 2));
    return { ok: true, path: file, dataUri: dataUri(r.png), info: `${r.cols}×${r.rows} grid, ${r.cellW}×${r.cellH} cells` };
  }

  throw new Error(`Unknown tool: ${op}`);
}

/** Path for a source, writing it to disk first if it only exists as a data URI. */
function materialize(source, assetsDir) {
  if (source?.path && fs.existsSync(source.path)) return source.path;
  return save(assetsDir, 'image', 'export', read(source));
}

function isGodotProject(dir) {
  try { return fs.existsSync(path.join(dir, 'project.godot')); } catch { return false; }
}

/** Copies files into <project>/<subdir> and returns their res:// paths. */
function exportToGodot(files, project, subdir = 'assets') {
  if (!isGodotProject(project)) throw new Error('That folder has no project.godot — pick the Godot project root.');
  const rel = String(subdir || 'assets').replace(/\\/g, '/').replace(/^\/+|\.\.+/g, '');
  const dest = path.join(project, rel);
  fs.mkdirSync(dest, { recursive: true });
  return files.map((f) => {
    const target = path.join(dest, path.basename(f));
    fs.copyFileSync(f, target);
    // Sheet metadata travels with its PNG.
    const meta = f.replace(/\.png$/i, '.json');
    if (fs.existsSync(meta)) fs.copyFileSync(meta, target.replace(/\.png$/i, '.json'));
    return 'res://' + path.relative(project, target).split(path.sep).join('/');
  });
}

module.exports = { run, materialize, exportToGodot, isGodotProject };
