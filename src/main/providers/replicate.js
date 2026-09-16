'use strict';
/**
 * Replicate backend.
 *
 * Chosen as the default paid route because it bills true pay-as-you-go: no
 * prepaid balance, no minimum, billed in arrears. You can run one prediction
 * for two cents and never come back.
 *
 * Two things here are easy to get wrong and are worth stating:
 *
 * 1. We call the OFFICIAL-model endpoint (/v1/models/{owner}/{name}/predictions)
 *    rather than /v1/predictions with a `version` hash. Version hashes change
 *    whenever the model is republished, and a pinned hash silently 404s months
 *    later. The named endpoint always resolves to the current version.
 *
 * 2. Output shape is per-model, not per-API. flux-depth-dev returns uri[];
 *    flux-kontext-dev returns a bare uri. Normalising that is the catalogue's
 *    `outputIsArray` flag, but we tolerate either shape regardless, because
 *    that is exactly the field most likely to drift.
 */

const { postJson, getJson, getBuffer, sleep } = require('../http');
const { findModel } = require('../../shared/models');

const API = 'https://api.replicate.com/v1';

// `Prefer: wait` holds the connection open until the prediction finishes, up to
// this many seconds, which removes the polling round-trip for most runs. FLUX
// Depth at 28 steps normally lands well inside it; we still poll if it does not.
const WAIT_SECONDS = 60;
const POLL_MS = 1500;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

function headers(key) {
  return { Authorization: `Bearer ${key}` };
}

/**
 * Verifies the token and reports the account, so the UI can say "connected as
 * X" rather than making the user run a generation to find out the key is wrong.
 */
async function testKey({ key, signal }) {
  const me = await getJson(`${API}/account`, { headers: headers(key), signal, timeoutMs: 15_000 });
  return { ok: true, label: me.username || me.name || 'account ok' };
}

/** The catalogue is static for Replicate; see shared/models.js for why. */
async function listModels() {
  return require('../../shared/models').REPLICATE_MODELS;
}

/** Pulls the live input schema for a model - used by `npm run check-models`. */
async function fetchSchema({ key, modelId, signal }) {
  const m = await getJson(`${API}/models/${modelId}`, { headers: headers(key), signal });
  const props = m?.latest_version?.openapi_schema?.components?.schemas?.Input?.properties || {};
  const output = m?.latest_version?.openapi_schema?.components?.schemas?.Output || {};
  return { fields: Object.keys(props), outputType: output.type || null, raw: props };
}

/** Builds the `input` object for a model from catalogue defaults + user params. */
function buildInput(model, { prompt, imageDataUri, params, outputFormat, numOutputs }) {
  const input = { ...model.defaults, prompt };

  if (model.imageField) {
    if (!imageDataUri) throw new Error(`${model.label} needs an input image.`);
    // Replicate accepts base64 data URIs for any `uri`-typed input, which saves
    // us uploading to their files API first. Large inputs are downscaled before
    // they reach here - see images.js.
    //
    // Three shapes exist across these models and they are not interchangeable:
    // control_image (uri), input_image (uri) and input_images (uri[], FLUX.2).
    // Sending a bare string where a list is expected is a 422.
    input[model.imageField] = model.imageFieldIsArray ? [imageDataUri] : imageDataUri;
  }

  // Only pass through params this model actually declares, so a slider left over
  // from a different model cannot 422 the request.
  //
  // Clamping matters for the same reason: settings hold one params object for
  // all models, so a guidance of 30 set on Canny (max 100) would otherwise
  // arrive at Kontext (max 10) and be rejected.
  for (const name of model.controls || []) {
    const v = params?.[name];
    if (v === undefined || v === null || v === '') continue;
    const range = model.ranges?.[name];
    input[name] =
      range && typeof v === 'number' ? Math.min(range[1], Math.max(range[0], v)) : v;
  }

  if (outputFormat) input.output_format = outputFormat;
  if ((model.controls || []).includes('num_outputs') && numOutputs) {
    input.num_outputs = Math.min(4, Math.max(1, numOutputs));
  }
  return input;
}

/** Normalises succeeded output into a list of URLs, whatever shape it arrived in. */
function outputUrls(output) {
  if (!output) return [];
  if (typeof output === 'string') return [output];
  if (Array.isArray(output)) return output.filter((x) => typeof x === 'string');
  if (typeof output === 'object' && typeof output.url === 'string') return [output.url];
  return [];
}

async function generate({ key, modelId, prompt, imageDataUri, params, outputFormat, numOutputs, signal, onStage }) {
  const model = findModel('replicate', modelId);
  if (!model) throw new Error(`Unknown Replicate model: ${modelId}`);

  const input = buildInput(model, { prompt, imageDataUri, params, outputFormat, numOutputs });

  onStage?.('Sending to Replicate…');
  let pred = await postJson(
    `${API}/models/${modelId}/predictions`,
    { input },
    {
      headers: { ...headers(key), Prefer: `wait=${WAIT_SECONDS}` },
      signal,
      // A little over the Prefer window, so our timeout never fires before theirs.
      timeoutMs: (WAIT_SECONDS + 15) * 1000,
    },
  );

  // Cold models (Kontext is often cold) exceed the wait window; fall back to polling.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (!TERMINAL.has(pred.status)) {
    if (Date.now() > deadline) throw new Error('Replicate did not finish within 10 minutes.');
    onStage?.(pred.status === 'starting' ? 'Waiting for a GPU (cold model)…' : 'Generating…');
    await sleep(POLL_MS, signal);
    pred = await getJson(pred.urls.get, { headers: headers(key), signal, timeoutMs: 30_000 });
  }

  if (pred.status !== 'succeeded') {
    throw new Error(pred.error ? String(pred.error) : `Prediction ${pred.status}.`);
  }

  const urls = outputUrls(pred.output);
  if (!urls.length) throw new Error('Replicate returned no image.');

  onStage?.(`Downloading ${urls.length} image${urls.length > 1 ? 's' : ''}…`);
  const images = [];
  for (const url of urls) {
    const data = await getBuffer(url, { signal });
    const ext = (url.split('?')[0].match(/\.(\w+)$/)?.[1] || outputFormat || 'png').toLowerCase();
    images.push({ data, ext });
  }

  return {
    images,
    // predict_time is the billed GPU time; the catalogue price is per output
    // image. Report both rather than pretending we know the exact charge.
    meta: {
      predictionId: pred.id,
      predictTime: pred.metrics?.predict_time ?? null,
      approxCost: (model.approxCost || 0) * images.length,
      model: modelId,
    },
  };
}

module.exports = {
  id: 'replicate',
  testKey,
  listModels,
  fetchSchema,
  generate,
  // exported for tests
  _buildInput: buildInput,
  _outputUrls: outputUrls,
};
