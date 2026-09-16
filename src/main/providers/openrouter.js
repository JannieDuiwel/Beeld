'use strict';
/**
 * OpenRouter backend.
 *
 * Here because it is the only route you can try with no card at all: new
 * accounts get free credits, and the balance simply stops working at zero
 * rather than billing you. That makes it the right first stop for "is this
 * even the quality I imagined".
 *
 * What it is NOT good for: the SketchUp workflow. The images endpoint takes a
 * prompt and optional reference images only - there is no depth or canny
 * conditioning on any model here, open-weight ones included - so you can
 * describe a change but cannot pin the geometry. The UI says so at the point of
 * choosing, rather than letting the results quietly disappoint.
 *
 * Models are discovered at runtime instead of pinned, because this catalogue
 * turns over every few weeks and a hardcoded id would rot fast.
 */

const { postJson, getJson } = require('../http');

const API = 'https://openrouter.ai/api/v1';

// Sent so usage shows up under a recognisable name on the OpenRouter dashboard.
const ATTRIBUTION = {
  'HTTP-Referer': 'https://github.com/JannieDuiwel/Beeld',
  'X-Title': 'Beeld',
};

function headers(key) {
  return { Authorization: `Bearer ${key}`, ...ATTRIBUTION };
}

async function testKey({ key, signal }) {
  const me = await getJson(`${API}/key`, { headers: headers(key), signal, timeoutMs: 15_000 });
  const d = me?.data || {};
  const left = d.limit_remaining;
  return {
    ok: true,
    label: left != null ? `key ok, $${Number(left).toFixed(2)} left` : 'key ok',
  };
}

/**
 * Live catalogue, filtered to models that can actually emit an image. The
 * endpoint is public, so this works before the user has pasted a key - which
 * is what lets the picker be populated on a fresh install.
 */
async function listModels({ signal } = {}) {
  const res = await getJson(`${API}/models?output_modalities=image`, { signal, timeoutMs: 20_000 });
  const list = Array.isArray(res?.data) ? res.data : [];

  return list
    // openrouter/auto* are meta-routers that pick a model for you. They sort to
    // the top alphabetically and would become the default choice, which is a
    // bad first experience: you cannot tell what actually ran or what it cost.
    .filter((m) => !String(m.id).startsWith('openrouter/auto'))
    .map((m) => {
      const inputs = m.architecture?.input_modalities || [];
      const takesImage = inputs.includes('image');
      return {
        id: m.id,
        label: m.name || m.id,
        // Anything that accepts an image can at least attempt an edit; the rest
        // are prompt-only. No closed model here does true structure control.
        kind: takesImage ? 'edit' : 'text2img',
        // Deliberately null. OpenRouter prices image models inconsistently -
        // some per image ("image"), most per output token ("image_output"),
        // and several report "image": "0" while charging per token. Guessing a
        // per-run figure from that would show "free" for models that are not.
        // The real charge comes back in usage.cost after the run.
        approxCost: null,
        blurb: takesImage
          ? 'Accepts a reference image. Describes changes rather than locking geometry.'
          : 'Prompt only - no input image.',
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Pulls image bytes out of whichever field the response used. */
async function collectImages(data, signal) {
  const { getBuffer } = require('../http');
  const out = [];
  for (const item of data) {
    if (item?.b64_json) {
      const ext = (item.media_type || 'image/png').split('/')[1] || 'png';
      out.push({ data: Buffer.from(item.b64_json, 'base64'), ext });
    } else if (typeof item?.url === 'string') {
      // Some upstreams hand back a URL instead of inline base64.
      out.push({ data: await getBuffer(item.url, { signal }), ext: 'png' });
    }
  }
  return out;
}

async function generate({ key, modelId, prompt, imageDataUri, numOutputs, signal, onStage }) {
  const body = { model: modelId, prompt };

  if (imageDataUri) {
    body.input_references = [{ type: 'image_url', image_url: { url: imageDataUri } }];
  }
  if (numOutputs && numOutputs > 1) body.n = numOutputs;

  onStage?.('Sending to OpenRouter…');
  const res = await postJson(`${API}/images`, body, {
    headers: headers(key),
    signal,
    timeoutMs: 180_000,
  });

  const data = Array.isArray(res?.data) ? res.data : [];
  const images = await collectImages(data, signal);
  if (!images.length) throw new Error('OpenRouter returned no image.');

  return {
    images,
    meta: {
      // OpenRouter reports the real charge, which is better than our estimate.
      approxCost: res?.usage?.cost ?? null,
      model: modelId,
    },
  };
}

// --- prompt assistance (free) ----------------------------------------------

/**
 * The free side of OpenRouter, put to the only use it can actually serve here.
 *
 * `openrouter/free` is the Free Models Router: it accepts text AND image input,
 * costs $0/$0, and outputs **text only** - as does every other `:free` model.
 * So free models cannot generate a picture. What they can do, for nothing, is
 * look at your SketchUp export and write the prompt for it.
 *
 * That turns out to be the part beginners get wrong anyway: FLUX-class models
 * follow plain descriptive language, and "a house" produces a generic house
 * while a paragraph about materials, light and setting produces the render you
 * actually wanted.
 *
 * Free models are rate limited (roughly 20 requests/minute), which is ample for
 * a button a person presses by hand.
 *
 * The default is a NAMED instruction-tuned vision model, not `openrouter/free`.
 * The router picks whatever free model is convenient, and the free pool
 * contains classifiers - `nvidia/nemotron-3.5-content-safety:free` is both free
 * and vision-capable. Routed there, "improve this prompt" comes back as
 * `User Safety: safe`, because a verdict is the only thing a guard model can
 * say. Pinning a general instruction model makes the result predictable.
 */
const ASSIST_MODEL = 'google/gemma-4-31b-it:free';

/**
 * Models that cannot write a prompt no matter how they are asked: safety
 * classifiers, moderation graders and guard models. They are excluded from the
 * picker rather than left to disappoint someone who selects one.
 */
const CLASSIFIER_RE = /guard|content-safety|safety|moderat|classif|shield/i;

const ASSIST_SYSTEM = [
  'You write prompts for image generation models such as FLUX.',
  'Rewrite the user\'s idea as one vivid paragraph of plain descriptive English.',
  'Describe materials, surface finish, lighting, weather, time of day, setting and camera framing.',
  'Never describe geometry, layout or composition that is already fixed by a reference image.',
  'Do not use keyword soup, weights, or terms like "8k", "masterpiece" or "trending on artstation".',
  'Reply with the prompt only - no preamble, no quotes, no explanation.',
].join(' ');

/**
 * OpenRouter's free models are exactly those whose id ends in `:free`, plus the
 * free router itself. Checked by name rather than by price lookup so it costs
 * no round trip and cannot be wrong about a model it has not heard of.
 */
function isFreeModelId(id) {
  return id === 'openrouter/free' || /:free$/.test(String(id || ''));
}

/**
 * Expands a terse prompt into something a diffusion model can use. When the
 * chosen model has vision and an input image is supplied, it reads the image so
 * the result describes the actual building rather than a guess.
 *
 * This runs on OpenRouter regardless of which backend will render the image -
 * there is no reason to pay a rendering provider for a paragraph of text.
 */
async function enhancePrompt({ key, prompt, imageDataUri, model, signal }) {
  const text = String(prompt || '').trim();
  if (!text && !imageDataUri) throw new Error('Type something to improve, or add an input image.');

  // Prompt help is a free-tier feature by design: it must never quietly start
  // billing because a paid id reached this setting (a hand-edited settings.json,
  // or a model that lost its free tier upstream).
  const chosen = model && isFreeModelId(model) ? model : ASSIST_MODEL;

  const instruction = imageDataUri
    ? `Here is the reference image this will be rendered from. Write the prompt for it.${text ? ` The user wants: ${text}` : ''}`
    : text;

  const content = imageDataUri
    ? [
        { type: 'text', text: instruction },
        { type: 'image_url', image_url: { url: imageDataUri } },
      ]
    : instruction;

  const res = await postJson(
    `${API}/chat/completions`,
    {
      model: chosen,
      messages: [
        { role: 'system', content: ASSIST_SYSTEM },
        { role: 'user', content },
      ],
      max_tokens: 400,
    },
    { headers: headers(key), signal, timeoutMs: 90_000 },
  );

  const out = res?.choices?.[0]?.message?.content;
  if (!out || !String(out).trim()) throw new Error('That model returned nothing — try again.');

  const cleaned = cleanAssistOutput(out);

  // A guard model answers every request with a verdict. Catching it here means
  // the user gets an explanation instead of "User Safety: safe" pasted into
  // their prompt box - and it also catches a router that lands on one.
  if (looksLikeClassifierVerdict(cleaned)) {
    const used = res.model || chosen;
    throw new Error(
      `${used} answered like a safety classifier, not a writer ("${cleaned.slice(0, 40)}").\n` +
        'Pick a different model under Settings → Prompt help runs on.',
    );
  }

  return {
    prompt: cleaned,
    model: res.model || chosen,
    // Free models report 0. A non-zero value here means the model lost its free
    // tier upstream, so it is surfaced rather than hidden.
    cost: res?.usage?.cost ?? 0,
  };
}

/**
 * Recognises the output shape of a moderation model. Deliberately narrow: it
 * must not reject a legitimate prompt that merely happens to mention safety,
 * so it only fires on a verdict-shaped answer or a very short bare verdict.
 */
function looksLikeClassifierVerdict(text) {
  const t = String(text).trim();
  if (/^\{?\s*"?(user|response)[ _]safety"?\s*[:=]/i.test(t)) return true;
  if (/^(safe|unsafe)\b[.,!]?$/i.test(t)) return true;
  // A verdict plus a category list, e.g. "unsafe\nS1,S4" - still far too short
  // to be a paragraph describing a building.
  if (t.length < 60 && /\b(un)?safe\b/i.test(t) && !/\s\w+\s\w+\s\w+\s\w+\s/.test(t)) return true;
  return false;
}

/** Strips the wrapping these models add even when told not to. */
function cleanAssistOutput(text) {
  return String(text)
    .trim()
    .replace(/^```[\w]*\n?|\n?```$/g, '')
    .replace(/^(here('s| is)[^:]*:|prompt:)\s*/i, '')
    .replace(/^["'“‘]|["'”’]$/g, '')
    .trim();
}

/** The free-only slice of the catalogue, for the assist-model picker. */
async function listFreeModels({ signal } = {}) {
  const res = await getJson(`${API}/models`, { signal, timeoutMs: 20_000 });
  const list = Array.isArray(res?.data) ? res.data : [];

  const free = list.filter(
    (m) =>
      (m.id === 'openrouter/free' ||
        (m.id.endsWith(':free') && Number(m.pricing?.prompt || 0) === 0)) &&
      // Guard models are free and some are vision-capable, so they sail through
      // every other filter and then answer "User Safety: safe" to everything.
      !CLASSIFIER_RE.test(`${m.id} ${m.name || ''}`),
  );

  return free
    .map((m) => ({
      id: m.id,
      label: m.name || m.id,
      // Only a vision model can look at the SketchUp export; the rest can still
      // expand a typed prompt, so both are offered and the UI says which is which.
      vision: (m.architecture?.input_modalities || []).includes('image'),
      // The router is kept as an option but never the default: it can land on
      // any free model, including ones ill-suited to writing a prompt.
      routed: m.id === 'openrouter/free',
    }))
    .sort((a, b) => (b.vision - a.vision) || (a.routed - b.routed) || a.label.localeCompare(b.label));
}

module.exports = {
  id: 'openrouter',
  testKey,
  listModels,
  generate,
  enhancePrompt,
  listFreeModels,
  ASSIST_MODEL,
  isFreeModelId,
  _collectImages: collectImages,
  _cleanAssistOutput: cleanAssistOutput,
  _looksLikeClassifierVerdict: looksLikeClassifierVerdict,
  _CLASSIFIER_RE: CLASSIFIER_RE,
};
