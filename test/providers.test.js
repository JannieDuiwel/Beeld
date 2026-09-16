'use strict';
/**
 * Provider request-shaping tests.
 *
 * These cover the pure functions only - no network. The point is the stuff that
 * is easy to get subtly wrong and expensive to discover live: which field the
 * input image goes in, whether output is a list or a bare string, and whether
 * a stale slider from another model can leak into a request and 422 it.
 */

const assert = require('assert');
const replicate = require('../src/main/providers/replicate');
const comfy = require('../src/main/providers/comfy');
const { findModel } = require('../src/shared/models');

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

console.log('replicate: input shaping');

test('depth model puts the image in control_image', () => {
  const m = findModel('replicate', 'black-forest-labs/flux-depth-dev');
  const input = replicate._buildInput(m, {
    prompt: 'a house',
    imageDataUri: 'data:image/png;base64,AAA',
    params: {},
  });
  assert.strictEqual(input.control_image, 'data:image/png;base64,AAA');
  assert.strictEqual(input.input_image, undefined);
});

test('kontext model puts the image in input_image', () => {
  const m = findModel('replicate', 'black-forest-labs/flux-kontext-dev');
  const input = replicate._buildInput(m, {
    prompt: 'make it brick',
    imageDataUri: 'data:image/png;base64,AAA',
    params: {},
  });
  assert.strictEqual(input.input_image, 'data:image/png;base64,AAA');
  assert.strictEqual(input.control_image, undefined);
});

test('a structure model refuses to run without an image', () => {
  const m = findModel('replicate', 'black-forest-labs/flux-depth-dev');
  assert.throws(
    () => replicate._buildInput(m, { prompt: 'x', imageDataUri: null, params: {} }),
    /needs an input image/,
  );
});

test('params not declared by the model are dropped', () => {
  // num_outputs belongs to Depth, not Kontext. A user who set it on one model
  // and switched must not have it leak into the other model request.
  const m = findModel('replicate', 'black-forest-labs/flux-kontext-dev');
  const input = replicate._buildInput(m, {
    prompt: 'x',
    imageDataUri: 'data:,',
    params: { num_outputs: 4, guidance: 3 },
  });
  assert.strictEqual(input.num_outputs, undefined);
  assert.strictEqual(input.guidance, 3);
});

test('a param from another model is clamped into range, not passed through', () => {
  // Settings hold one params object across models. Guidance 30 is legal on
  // Canny (max 100) and illegal on Kontext (max 10); switching models must not
  // send the stale value and get a 422.
  const m = findModel('replicate', 'black-forest-labs/flux-kontext-dev');
  const input = replicate._buildInput(m, {
    prompt: 'x', imageDataUri: 'data:,', params: { guidance: 30 },
  });
  assert.strictEqual(input.guidance, 10);
});

test('clamping also raises a value below the minimum', () => {
  const m = findModel('replicate', 'black-forest-labs/flux-kontext-dev');
  const input = replicate._buildInput(m, {
    prompt: 'x', imageDataUri: 'data:,', params: { num_inference_steps: 1 },
  });
  assert.strictEqual(input.num_inference_steps, 4);
});

test('catalogue defaults survive when no param overrides them', () => {
  const m = findModel('replicate', 'black-forest-labs/flux-depth-dev');
  const input = replicate._buildInput(m, { prompt: 'x', imageDataUri: 'data:,', params: {} });
  assert.strictEqual(input.megapixels, 'match_input');
  assert.strictEqual(input.guidance, 10);
});

test('an empty string param does not override a default', () => {
  const m = findModel('replicate', 'black-forest-labs/flux-depth-dev');
  const input = replicate._buildInput(m, {
    prompt: 'x', imageDataUri: 'data:,', params: { guidance: '' },
  });
  assert.strictEqual(input.guidance, 10);
});

console.log('replicate: output normalising');

test('a bare uri (kontext) becomes a one-item list', () => {
  assert.deepStrictEqual(replicate._outputUrls('https://x/a.png'), ['https://x/a.png']);
});

test('a uri[] (depth) passes through', () => {
  assert.deepStrictEqual(
    replicate._outputUrls(['https://x/a.png', 'https://x/b.png']),
    ['https://x/a.png', 'https://x/b.png'],
  );
});

test('null output yields nothing rather than throwing', () => {
  assert.deepStrictEqual(replicate._outputUrls(null), []);
});

console.log('openrouter: prompt assistance');

const openrouter = require('../src/main/providers/openrouter');
const clean = openrouter._cleanAssistOutput;

test('a fenced code block is unwrapped', () => {
  assert.strictEqual(clean('```\na stone cottage\n```'), 'a stone cottage');
  assert.strictEqual(clean('```text\na stone cottage\n```'), 'a stone cottage');
});

test('conversational preamble is stripped', () => {
  // Small free models add this constantly, however firmly the system prompt
  // tells them not to.
  assert.strictEqual(clean("Here's the prompt: a stone cottage"), 'a stone cottage');
  assert.strictEqual(clean('Here is an improved prompt: a stone cottage'), 'a stone cottage');
  assert.strictEqual(clean('Prompt: a stone cottage'), 'a stone cottage');
});

test('surrounding quotes are removed, including smart ones', () => {
  assert.strictEqual(clean('"a stone cottage"'), 'a stone cottage');
  assert.strictEqual(clean('“a stone cottage”'), 'a stone cottage');
});

test('a clean answer is left exactly as it is', () => {
  const good = 'A low stone cottage at golden hour, weathered slate roof, warm light.';
  assert.strictEqual(clean(good), good);
});

test('an internal colon is not mistaken for a preamble', () => {
  const s = 'a cottage at dusk: warm windows, blue sky';
  assert.strictEqual(clean(s), s);
});

console.log('openrouter: guard-model rejection');

const isVerdict = openrouter._looksLikeClassifierVerdict;

test('a single-line safety verdict is rejected', () => {
  // This is verbatim what nvidia/nemotron-3.5-content-safety:free returns.
  assert.ok(isVerdict('User Safety: safe'));
});

test('a multi-line safety verdict is rejected', () => {
  // Verbatim output from the guard model, as it appeared in the prompt box.
  assert.ok(isVerdict(
    'User Safety: safe\nResponse Safety: safe\nSafety Categories: Needs Caution',
  ));
});

test('a JSON-shaped verdict is rejected', () => {
  assert.ok(isVerdict('{"User Safety": "safe"}'));
});

test('a bare verdict word is rejected', () => {
  assert.ok(isVerdict('safe'));
  assert.ok(isVerdict('unsafe'));
  assert.ok(isVerdict('unsafe\nS1,S4'));
});

test('a real prompt mentioning safety is NOT rejected', () => {
  // The detector must not fire on legitimate prose; a false positive would
  // throw away a good rewrite.
  assert.ok(!isVerdict(
    'A modern two-storey house at dusk with safety railings along the balcony, ' +
    'warm amber light spilling from floor-to-ceiling glass onto wet paving.',
  ));
});

test('guard models are matched by the catalogue filter', () => {
  const re = openrouter._CLASSIFIER_RE;
  assert.ok(re.test('nvidia/nemotron-3.5-content-safety:free'));
  assert.ok(re.test('meta-llama/llama-guard-4'));
  assert.ok(!re.test('google/gemma-4-31b-it:free'));
  assert.ok(!re.test('openrouter/free'));
});

console.log('openrouter: assist stays on the free tier');

test('free ids are recognised', () => {
  assert.ok(openrouter.isFreeModelId('openrouter/free'));
  assert.ok(openrouter.isFreeModelId('google/gemma-4-31b-it:free'));
});

test('paid ids are not mistaken for free', () => {
  // Prompt help must never silently start billing because a paid id reached
  // the setting - by hand-edited settings.json, or a model losing its free tier.
  assert.ok(!openrouter.isFreeModelId('google/gemini-3.1-flash-image'));
  assert.ok(!openrouter.isFreeModelId('black-forest-labs/flux.2-pro'));
  assert.ok(!openrouter.isFreeModelId(''));
  assert.ok(!openrouter.isFreeModelId(undefined));
});

test('a :free substring elsewhere does not count', () => {
  assert.ok(!openrouter.isFreeModelId('vendor/:free-lunch'));
});

console.log('replicate: FLUX.2 array image field');

test('flux-2-pro wraps the image in a list', () => {
  // input_images is uri[]; a bare string here is a 422.
  const m = findModel('replicate', 'black-forest-labs/flux-2-pro');
  const input = replicate._buildInput(m, {
    prompt: 'a house at dusk',
    imageDataUri: 'data:image/png;base64,AAA',
    params: {},
  });
  assert.deepStrictEqual(input.input_images, ['data:image/png;base64,AAA']);
});

test('single-image models still send a bare string', () => {
  const m = findModel('replicate', 'black-forest-labs/flux-depth-dev');
  const input = replicate._buildInput(m, {
    prompt: 'x', imageDataUri: 'data:,', params: {},
  });
  assert.strictEqual(typeof input.control_image, 'string');
});

console.log('comfyui: workflow placeholders');

test('placeholders are replaced everywhere in the graph', () => {
  const wf = {
    3: { inputs: { text: 'a %PROMPT% at dusk' } },
    5: { inputs: { image: '%IMAGE%' } },
  };
  const out = comfy._substitute(wf, { prompt: 'farmhouse', image: 'in.png', seed: 7 });
  assert.strictEqual(out['3'].inputs.text, 'a farmhouse at dusk');
  assert.strictEqual(out['5'].inputs.image, 'in.png');
});

test('substitution does not mutate the loaded workflow', () => {
  const wf = { 3: { inputs: { text: '%PROMPT%' } } };
  comfy._substitute(wf, { prompt: 'x', image: '', seed: 1 });
  assert.strictEqual(wf['3'].inputs.text, '%PROMPT%');
});

test('seed fields end up numeric, not strings', () => {
  // ComfyUI rejects a string where an INT is declared, and the substitution
  // pass would otherwise leave "12345" behind.
  const wf = comfy._substitute(
    { 3: { inputs: { seed: '%SEED%' } }, 4: { inputs: { noise_seed: '%SEED%' } } },
    { prompt: '', image: '', seed: 12345 },
  );
  const fixed = comfy._coerceSeeds(wf, 12345);
  assert.strictEqual(fixed['3'].inputs.seed, 12345);
  assert.strictEqual(fixed['4'].inputs.noise_seed, 12345);
});

console.log(`\n${passed} passed`);
