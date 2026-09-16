'use strict';
/**
 * The model catalogue: the ONE place provider ids, model ids and input field
 * names live. Everything else (UI, providers, tests) reads from here.
 *
 * Why a hand-written table instead of discovering everything at runtime:
 * Replicate's schema endpoint needs the user's token, so we cannot populate a
 * model picker before they have signed up. Hardcoding means the picker works
 * on first launch with an empty account.
 *
 * The risk of hardcoding is that a field name silently changes upstream and
 * every call 422s. `npm run check-models` fetches the live schema and diffs it
 * against this table, so that risk is checkable rather than latent. `verified`
 * records when a human last confirmed the fields against the published schema.
 *
 * `kind` drives the UI: it decides whether an input image is required, optional
 * or ignored, and which sliders are worth showing.
 *   text2img  - prompt only, no input image
 *   structure - input image constrains geometry, prompt decides everything else
 *   edit      - input image is the subject, prompt is an instruction
 */

// Field names marked (verified) were read off the published schema on this date.
const VERIFIED = '2026-09-16';

const REPLICATE_MODELS = [
  {
    id: 'black-forest-labs/flux-depth-dev',
    label: 'FLUX Depth — keep the geometry',
    kind: 'structure',
    imageField: 'control_image',   // (verified) depth map is generated for us
    outputIsArray: true,           // (verified) schema output type is uri[]
    approxCost: 0.025,
    verified: VERIFIED,
    blurb:
      'Reads the depth of your input and rebuilds the scene around it. The best ' +
      'starting point for a SketchUp or CAD export: rooflines and proportions ' +
      'survive, materials and lighting come from the prompt.',
    defaults: { guidance: 10, num_inference_steps: 28, megapixels: 'match_input' },
    controls: ['guidance', 'num_inference_steps', 'num_outputs', 'seed'],
    ranges: { guidance: [1, 30], num_inference_steps: [1, 50], num_outputs: [1, 4] },
  },
  {
    id: 'black-forest-labs/flux-canny-dev',
    label: 'FLUX Canny — keep the lines',
    kind: 'structure',
    imageField: 'control_image',   // sibling of flux-depth-dev, same schema shape
    outputIsArray: true,
    approxCost: 0.025,
    verified: VERIFIED,
    blurb:
      'Follows the edges rather than the depth. Better than Depth when the input ' +
      'is line art, a hidden-line CAD view or a pencil sketch with no real shading.',
    defaults: { guidance: 30, num_inference_steps: 28, megapixels: 'match_input' },
    controls: ['guidance', 'num_inference_steps', 'num_outputs', 'seed'],
    ranges: { guidance: [1, 100], num_inference_steps: [1, 50], num_outputs: [1, 4] },
  },
  {
    id: 'black-forest-labs/flux-kontext-dev',
    label: 'FLUX Kontext — tell it what to change',
    kind: 'edit',
    imageField: 'input_image',     // (verified) NOT control_image
    outputIsArray: false,          // (verified) schema output type is a bare uri
    approxCost: 0.025,
    verified: VERIFIED,
    blurb:
      'Instruction editing. Give it an image and a sentence ("make the cladding ' +
      'charred timber, overcast light") and it changes that one thing. Best used ' +
      'after Depth has given you a render worth iterating on.',
    defaults: { guidance: 2.5, num_inference_steps: 28, aspect_ratio: 'match_input_image' },
    controls: ['guidance', 'num_inference_steps', 'seed'],
    ranges: { guidance: [1, 10], num_inference_steps: [4, 50] },
  },
  {
    id: 'black-forest-labs/flux-2-pro',
    label: 'FLUX.2 Pro — reference images',
    kind: 'edit',
    imageField: 'input_images',    // (verified) an ARRAY, up to 8 references
    imageFieldIsArray: true,
    outputIsArray: false,          // (verified) schema output type is a bare uri
    // "Priced by multiple properties" on Replicate - resolution and references
    // both move it - so there is no honest flat figure to show before the run.
    approxCost: null,
    verified: VERIFIED,
    blurb:
      'Takes your model as a reference and rebuilds the whole scene around it. ' +
      'Less literal than Depth about geometry, but far stronger on lighting, ' +
      'weather, people and cars - use it when you want the photograph, not the ' +
      'elevation.',
    defaults: { aspect_ratio: 'match_input_image', resolution: 'match_input_image' },
    controls: ['safety_tolerance', 'seed'],
    ranges: { safety_tolerance: [1, 5] },
  },
  {
    id: 'black-forest-labs/flux-schnell',
    label: 'FLUX Schnell — fast and cheap',
    kind: 'text2img',
    imageField: null,
    outputIsArray: true,
    approxCost: 0.003,
    verified: VERIFIED,
    blurb:
      'Four-step model, fractions of a cent per image. Use it to burn through ' +
      'prompt ideas before spending real money on a Depth run.',
    defaults: { num_inference_steps: 4, aspect_ratio: '1:1' },
    controls: ['num_inference_steps', 'num_outputs', 'aspect_ratio', 'seed'],
    ranges: { num_inference_steps: [1, 4], num_outputs: [1, 4] },
  },
];

/**
 * OpenRouter is deliberately thin here. Its catalogue changes weekly and the
 * models are mostly closed-weight, so the app discovers them at runtime from
 * /api/v1/models?output_modalities=image rather than pinning ids that rot.
 * This entry is only the fallback shown before that call returns.
 */
const OPENROUTER_FALLBACK = [
  {
    id: 'google/gemini-2.5-flash-image-preview',
    label: 'Gemini Flash Image (fallback entry)',
    kind: 'edit',
    approxCost: 0.03,
    blurb: 'Placeholder until the live model list loads.',
  },
];

/**
 * ComfyUI has no model list of its own - the exported workflow IS the choice of
 * model, sampler and ControlNet. But the UI needs something selectable, and an
 * empty picker would make Generate refuse to run, so there is exactly one
 * pseudo-entry standing in for "whatever the workflow does".
 *
 * kind is 'edit' rather than 'structure' because whether an input image is
 * needed depends entirely on the workflow, and warning about a missing image
 * would be wrong half the time.
 */
const COMFY_MODELS = [
  {
    id: 'workflow',
    label: 'Your exported workflow',
    kind: 'edit',
    imageField: null,
    approxCost: 0,
    blurb:
      'Runs the workflow chosen in Settings. Prompt and image are substituted ' +
      'into it via the %PROMPT% and %IMAGE% tokens.',
  },
];

const PROVIDERS = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyHint: 'Starts with sk-or-',
    blurb:
      'Free credits at signup, no card needed to start. Prompt-and-reference ' +
      'only - no depth or canny conditioning - so it is the place to taste-test ' +
      'quality, not to run the SketchUp workflow.',
    discovers: true,
  },
  {
    id: 'replicate',
    label: 'Replicate',
    needsKey: true,
    keyUrl: 'https://replicate.com/account/api-tokens',
    keyHint: 'Starts with r8_',
    blurb:
      'True pay-as-you-go, no minimum and no prepaid balance required. Open ' +
      'weights, so anything you build here also runs locally later.',
    discovers: false,
  },
  {
    id: 'comfy',
    label: 'Local ComfyUI',
    needsKey: false,
    keyUrl: 'https://github.com/patientx/ComfyUI-Zluda',
    keyHint: 'Needs ComfyUI running, default http://127.0.0.1:8188',
    blurb:
      'Zero marginal cost and nothing leaves the machine. Needs ComfyUI running ' +
      'on the desktop and a workflow saved in API format.',
    discovers: false,
  },
];

function modelsFor(providerId) {
  if (providerId === 'replicate') return REPLICATE_MODELS;
  if (providerId === 'openrouter') return OPENROUTER_FALLBACK;
  if (providerId === 'comfy') return COMFY_MODELS;
  return [];
}

function findModel(providerId, modelId) {
  return modelsFor(providerId).find((m) => m.id === modelId) || null;
}

function provider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

module.exports = {
  PROVIDERS,
  REPLICATE_MODELS,
  OPENROUTER_FALLBACK,
  COMFY_MODELS,
  modelsFor,
  findModel,
  provider,
};
