#!/usr/bin/env node
'use strict';
/**
 * Beeld MCP server: lets Claude generate game/art assets through Beeld's
 * swappable providers, post-process them (pixelate, cut out, spritesheet) and
 * hand them over ready for Godot.
 *
 * Keys come from the environment (Beeld's own keys sit in Electron safeStorage,
 * which a stdio process cannot read):
 *   REPLICATE_API_TOKEN, OPENROUTER_API_KEY, optional COMFY_URL
 *   BEELD_PROVIDER (default replicate), BEELD_MODEL, BEELD_ASSET_DIR
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const providers = require('../src/main/providers');
const ops = require('../src/main/imgops');

const ROOT = process.env.BEELD_ASSET_DIR || path.join(os.homedir(), 'Pictures', 'Beeld', 'Assets');
const KEYS = { replicate: 'REPLICATE_API_TOKEN', openrouter: 'OPENROUTER_API_KEY', comfy: 'COMFY_URL' };
const DEFAULT_MODEL = { replicate: 'black-forest-labs/flux-schnell' };

// One source of truth with the app: the Game presets in shared/presets.js.
const { PRESETS } = require('../src/shared/presets');
const STYLES = { none: '', ...Object.fromEntries(['pixel', 'sprite', 'icon', 'tile']
  .map((k) => [k, PRESETS.find((p) => p.id === `game-${k}`).suffix])) };

const safe = (s) => String(s || 'asset').replace(/[^\w.-]+/g, '_').slice(0, 60);
const projectDir = (p) => path.join(ROOT, safe(p || 'default'));
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const write = (file, buf) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf); return file; };

/** Preview for Claude: enlarge tiny sprites (nearest), shrink huge ones. */
async function preview(buf) {
  const m = await sharp(buf).metadata();
  const longest = Math.max(m.width, m.height);
  let img = sharp(buf);
  if (longest < 256) img = img.resize(m.width * Math.floor(256 / longest), m.height * Math.floor(256 / longest), { kernel: 'nearest' });
  else if (longest > 768) img = img.resize({ width: m.width >= m.height ? 768 : undefined, height: m.height > m.width ? 768 : undefined });
  // Flatten transparency onto a checker-ish grey so cut-outs are visible.
  const out = await img.flatten({ background: '#808080' }).png().toBuffer();
  return { type: 'image', data: out.toString('base64'), mimeType: 'image/png' };
}

const text = (o) => ({ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) });
const fail = (e) => ({ isError: true, content: [text(`Error: ${e.message || e}`)] });
const wrap = (fn) => async (a) => { try { return await fn(a); } catch (e) { return fail(e); } };

const server = new McpServer({ name: 'beeld', version: '0.1.0' });

server.registerTool('list_models', {
  description: 'List image models for a provider (replicate | openrouter | comfy).',
  inputSchema: { provider: z.enum(['replicate', 'openrouter', 'comfy']).optional() },
}, wrap(async ({ provider }) => {
  const p = provider || process.env.BEELD_PROVIDER || 'replicate';
  const list = await providers.get(p).listModels({ key: process.env[KEYS[p]] });
  return { content: [text(list.map((m) => ({ id: m.id, kind: m.kind, cost: m.approxCost, note: m.blurb })))] };
}));

server.registerTool('generate_asset', {
  description: 'Generate image(s) with a Beeld provider and save them under the project folder. '
    + 'style adds prompt wording: pixel, sprite (magenta background for cut-out), icon, tile. '
    + 'Costs money on paid providers. For pixel art, generate then call pixelate.',
  inputSchema: {
    prompt: z.string(),
    project: z.string().optional().describe('Folder name to group assets, e.g. the game name'),
    name: z.string().optional().describe('File name stem'),
    style: z.enum(['none', 'pixel', 'sprite', 'icon', 'tile']).optional(),
    n: z.number().int().min(1).max(4).optional(),
    provider: z.enum(['replicate', 'openrouter', 'comfy']).optional(),
    model: z.string().optional(),
    reference_image: z.string().optional().describe('Path to an input image (edit/img2img models)'),
  },
}, wrap(async (a) => {
  const provider = a.provider || process.env.BEELD_PROVIDER || 'replicate';
  const modelId = a.model || process.env.BEELD_MODEL || DEFAULT_MODEL[provider];
  if (!modelId) throw new Error(`No model set for ${provider}: pass model or set BEELD_MODEL (see list_models).`);
  const key = process.env[KEYS[provider]];
  if (!key && provider !== 'comfy') throw new Error(`Missing ${KEYS[provider]} in the MCP server environment.`);

  const suffix = STYLES[a.style || 'none'];
  const prompt = suffix ? `${a.prompt}, ${suffix}` : a.prompt;
  let imageDataUri = null;
  if (a.reference_image) {
    const b = fs.readFileSync(a.reference_image);
    imageDataUri = `data:image/png;base64,${(await sharp(b).png().toBuffer()).toString('base64')}`;
  }
  const res = await providers.get(provider).generate({
    key, modelId, prompt, imageDataUri, params: {}, numOutputs: a.n || 1, outputFormat: 'png',
    comfyUrl: process.env.COMFY_URL,
  });

  const dir = path.join(projectDir(a.project), 'raw');
  const content = [];
  const files = [];
  for (let i = 0; i < res.images.length; i++) {
    const png = await sharp(res.images[i].data).png().toBuffer();
    const f = write(path.join(dir, `${safe(a.name)}_${stamp()}_${i + 1}.png`), png);
    files.push(f);
    content.push(await preview(png));
  }
  content.unshift(text({ files, provider, model: modelId, cost: res.meta?.approxCost ?? null, prompt }));
  return { content };
}));

const inputPath = z.string().describe('Absolute path to a PNG/JPG');
const outOpts = { project: z.string().optional(), name: z.string().optional() };
const outFile = (a, base, tag) => a.output || path.join(projectDir(a.project), 'processed', `${safe(a.name || path.parse(base).name)}_${tag}.png`);

server.registerTool('pixelate', {
  description: 'Convert an image to true pixel art: downscale to `width` px wide, reduce to `colors` colours '
    + '(or a given hex palette), optional ordered dither. scale upsizes with nearest-neighbour for viewing; '
    + 'leave scale=1 for the game-ready native-res file (import in Godot with Filter: Nearest).',
  inputSchema: { input: inputPath, width: z.number().int().min(4).max(512), colors: z.number().int().min(2).max(64).optional(),
    palette: z.array(z.string()).optional().describe('Hex colours like "#1a1c2c"; overrides colors'),
    dither: z.boolean().optional(), scale: z.number().int().min(1).max(32).optional(), output: z.string().optional(), ...outOpts },
}, wrap(async (a) => {
  const palette = a.palette?.map((h) => { const n = parseInt(h.replace('#', ''), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; });
  const r = await ops.pixelate(fs.readFileSync(a.input), { width: a.width, colors: a.colors, dither: a.dither, scale: a.scale, palette });
  const f = write(outFile(a, a.input, `px${a.width}`), r.png);
  const hex = r.palette.map((c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join(''));
  return { content: [text({ file: f, size: [r.width, r.height], palette: hex }), await preview(r.png)] };
}));

server.registerTool('remove_background', {
  description: 'Make the flat background transparent (flood fill from the edges; background colour auto-detected '
    + 'from the corners, or pass hex). Best with style=sprite (magenta) generations. Optionally trims empty edges.',
  inputSchema: { input: inputPath, tolerance: z.number().min(0).max(255).optional(), color: z.string().optional(),
    trim: z.boolean().optional(), output: z.string().optional(), ...outOpts },
}, wrap(async (a) => {
  let color;
  if (a.color) { const n = parseInt(a.color.replace('#', ''), 16); color = [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  const r = await ops.removeBackground(fs.readFileSync(a.input), { tolerance: a.tolerance, color });
  const png = a.trim ? await ops.trim(r.png) : r.png;
  const f = write(outFile(a, a.input, 'cut'), png);
  return { content: [text({ file: f, background: r.background }), await preview(png)] };
}));

server.registerTool('make_spritesheet', {
  description: 'Pack frames into a grid spritesheet and write a .json describing cols/rows/cell size '
    + '(Godot: Sprite2D hframes/vframes, or AnimatedSprite2D via SpriteFrames).',
  inputSchema: { frames: z.array(inputPath).min(1), cols: z.number().int().optional(),
    cell: z.tuple([z.number().int(), z.number().int()]).optional(), padding: z.number().int().optional(),
    output: z.string().optional(), ...outOpts },
}, wrap(async (a) => {
  const r = await ops.spritesheet(a.frames.map((f) => fs.readFileSync(f)), { cols: a.cols, cell: a.cell, padding: a.padding });
  const f = write(outFile(a, 'sheet', 'sheet'), r.png);
  const meta = { file: f, hframes: r.cols, vframes: r.rows, cell: [r.cellW, r.cellH], frames: r.frames, size: [r.width, r.height] };
  fs.writeFileSync(f.replace(/\.png$/, '.json'), JSON.stringify(meta, null, 2));
  return { content: [text(meta), await preview(r.png)] };
}));

server.registerTool('view_image', {
  description: 'Look at an image file (small sprites are enlarged with nearest-neighbour).',
  inputSchema: { input: inputPath },
}, wrap(async ({ input }) => ({ content: [await preview(fs.readFileSync(input))] })));

server.registerTool('export_to_godot', {
  description: 'Copy finished assets into a Godot project folder (containing project.godot) and return res:// paths. '
    + 'Pixel art tip: Project Settings > Rendering > Textures > Default Texture Filter = Nearest.',
  inputSchema: { files: z.array(inputPath).min(1), godot_project: z.string().describe('Folder containing project.godot'),
    subdir: z.string().optional().describe('Folder inside the project, default assets') },
}, wrap(async ({ files, godot_project, subdir }) => {
  if (!fs.existsSync(path.join(godot_project, 'project.godot'))) throw new Error('No project.godot in that folder.');
  const dest = path.join(godot_project, subdir || 'assets');
  fs.mkdirSync(dest, { recursive: true });
  const out = files.map((f) => {
    const t = path.join(dest, path.basename(f));
    fs.copyFileSync(f, t);
    return 'res://' + path.relative(godot_project, t).split(path.sep).join('/');
  });
  return { content: [text({ exported: out, note: 'Godot imports on next focus; set texture filter to Nearest for pixel art.' })] };
}));

server.connect(new StdioServerTransport());
