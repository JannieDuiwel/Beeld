'use strict';
/**
 * Provider registry and dispatch.
 *
 * The whole point of this layer: every backend answers the same three calls, so
 * "which route do I commit to" stops being a decision. Swapping OpenRouter for
 * Replicate for a local ComfyUI is a dropdown, not a rewrite - and a workflow
 * worked out on a paid API can move down to the desktop later unchanged.
 *
 * Contract every provider implements:
 *   testKey({ key, comfyUrl, signal })            -> { ok, label }
 *   listModels({ key, signal })                   -> [{ id, label, kind, approxCost, blurb }]
 *   generate({ ...job, signal, onStage })         -> { images: [{ data: Buffer, ext }], meta }
 */

const openrouter = require('./openrouter');
const replicate = require('./replicate');
const comfy = require('./comfy');

const REGISTRY = { openrouter, replicate, comfy };

function get(id) {
  const p = REGISTRY[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

module.exports = { get, REGISTRY };
