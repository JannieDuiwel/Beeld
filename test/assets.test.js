'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const assetops = require('../src/main/assetops');
const { PRESETS } = require('../src/shared/presets');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeld-assets-'));
  const src = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#ff00ff' } })
    .composite([{ input: await sharp({ create: { width: 48, height: 48, channels: 3, background: '#33aa33' } }).png().toBuffer(), left: 24, top: 24 }])
    .png().toBuffer();
  const srcFile = path.join(dir, 'hero.png');
  fs.writeFileSync(srcFile, src);

  const cut = await assetops.run('cutout', { source: { path: srcFile } }, dir);
  assert(cut.ok && fs.existsSync(cut.path));
  assert.strictEqual((await sharp(cut.path).metadata()).width, 48, 'trimmed to the sprite');

  const px = await assetops.run('pixelate', { source: { path: cut.path }, options: { width: 12, colors: 4, scale: 2 } }, dir);
  assert.strictEqual((await sharp(px.path).metadata()).width, 24);

  const sheet = await assetops.run('sheet', { sources: [{ path: px.path }, { dataUri: px.dataUri }], options: { cols: 2 } }, dir);
  assert(fs.existsSync(sheet.path.replace(/\.png$/, '.json')));

  const godot = path.join(dir, 'game');
  fs.mkdirSync(godot);
  assert.throws(() => assetops.exportToGodot([sheet.path], godot), /project\.godot/);
  fs.writeFileSync(path.join(godot, 'project.godot'), '');
  const out = assetops.exportToGodot([sheet.path], godot, 'art/sprites');
  assert(/^res:\/\/art\/sprites\/hero_sheet_.*\.png$|^res:\/\/art\/sprites\/sheet_sheet_.*\.png$/.test(out[0]), out[0]);
  assert(fs.existsSync(path.join(godot, 'art', 'sprites', path.basename(sheet.path).replace('.png', '.json'))));
  // escaping the project via subdir must not work
  const esc = assetops.exportToGodot([sheet.path], godot, '../../evil');
  assert(esc[0].startsWith('res://') && !esc[0].includes('..'));

  assert(['game-pixel', 'game-sprite', 'game-icon', 'game-tile'].every((id) => PRESETS.some((p) => p.id === id)));
  console.log('assets: ok');
})().catch((e) => { console.error(e); process.exit(1); });
