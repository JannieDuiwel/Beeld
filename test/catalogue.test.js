'use strict';
/**
 * Catalogue and preset integrity.
 *
 * Cheap structural checks on src/shared/models.js. They will not catch a field
 * name that drifted upstream - that is what `npm run check-models` is for - but
 * they do catch the local mistakes: a model whose controls reference a range
 * that does not exist, a structure model with no image field, a provider the
 * registry cannot resolve.
 */

const assert = require('assert');
const { PROVIDERS, REPLICATE_MODELS, modelsFor, findModel } = require('../src/shared/models');
const { PRESETS, applyPreset } = require('../src/shared/presets');
const providers = require('../src/main/providers');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('catalogue');

test('every provider resolves to a registered implementation', () => {
  for (const p of PROVIDERS) {
    const impl = providers.get(p.id);
    assert.ok(typeof impl.generate === 'function', `${p.id} has no generate()`);
    assert.ok(typeof impl.listModels === 'function', `${p.id} has no listModels()`);
    assert.ok(typeof impl.testKey === 'function', `${p.id} has no testKey()`);
  }
});

test('model ids are unique', () => {
  const ids = REPLICATE_MODELS.map((m) => m.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('structure and edit models declare an image field', () => {
  for (const m of REPLICATE_MODELS) {
    if (m.kind === 'structure' || m.kind === 'edit') {
      assert.ok(m.imageField, `${m.id} is ${m.kind} but has no imageField`);
    } else {
      assert.strictEqual(m.imageField, null, `${m.id} is ${m.kind} but declares an imageField`);
    }
  }
});

test('every slider control has a range to draw', () => {
  for (const m of REPLICATE_MODELS) {
    for (const c of m.controls || []) {
      if (c === 'seed' || c === 'aspect_ratio') continue;
      assert.ok(m.ranges?.[c], `${m.id} lists control "${c}" with no range`);
    }
  }
});

test('catalogue defaults sit inside their declared ranges', () => {
  for (const m of REPLICATE_MODELS) {
    for (const [k, v] of Object.entries(m.defaults || {})) {
      const r = m.ranges?.[k];
      if (!r || typeof v !== 'number') continue;
      assert.ok(v >= r[0] && v <= r[1], `${m.id}.${k} default ${v} is outside [${r}]`);
    }
  }
});

test('findModel returns null rather than throwing on a bad id', () => {
  assert.strictEqual(findModel('replicate', 'nope/nope'), null);
  assert.deepStrictEqual(modelsFor('no-such-provider'), []);
});

test('every provider offers at least one selectable model', () => {
  // An empty picker makes Generate refuse to run, which is how ComfyUI was
  // briefly unusable - it has no model list of its own.
  for (const p of PROVIDERS) {
    assert.ok(modelsFor(p.id).length > 0, `${p.id} has no models to select`);
  }
});

test('an unknown provider is a clear error', () => {
  assert.throws(() => providers.get('nope'), /Unknown provider/);
});

console.log('presets');

test('preset ids are unique and "none" exists', () => {
  const ids = PRESETS.map((p) => p.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(ids.includes('none'));
});

test('a preset appends without doubling punctuation', () => {
  assert.ok(applyPreset('a house', 'archviz-day').startsWith('a house, architectural'));
  assert.ok(applyPreset('a house.', 'archviz-day').startsWith('a house. architectural'));
});

test('"none" leaves the prompt untouched', () => {
  assert.strictEqual(applyPreset('  a house  ', 'none'), 'a house');
});

test('an empty prompt with a preset yields just the preset', () => {
  assert.strictEqual(applyPreset('', 'photo'), PRESETS.find((p) => p.id === 'photo').suffix);
});

test('an unknown preset id degrades to the bare prompt', () => {
  assert.strictEqual(applyPreset('a house', 'does-not-exist'), 'a house');
});

console.log(`\n${passed} passed`);
