'use strict';
/**
 * Local ComfyUI backend.
 *
 * The end state this app is aiming at: zero marginal cost, nothing leaves the
 * machine, and any model or workflow you like. It needs ComfyUI running on the
 * desktop - on an RX 6800XT that means the ZLUDA fork, because AMD's official
 * ROCm-on-Windows support covers RDNA3/RDNA4 only and the 6800XT is RDNA2.
 *
 * Rather than generate workflows (which would mean reimplementing ComfyUI's
 * node graph in here, badly), the user exports a working graph from ComfyUI
 * itself via "Save (API format)" and points the app at the file. We substitute
 * a few placeholder tokens and post it. That keeps the full power of the node
 * editor and means a workflow tuned by hand is the same artifact the app runs.
 *
 * Placeholders, written anywhere in the workflow's string values:
 *   %PROMPT%  - the composed prompt
 *   %IMAGE%   - filename of the uploaded input image (use in a LoadImage node)
 *   %SEED%    - a fresh random seed per run
 */

const fs = require('fs');
const { getJson, postJson, getBuffer, sleep } = require('../http');

const POLL_MS = 1000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;   // local runs on a busy GPU can be slow

function base(url) {
  return String(url || 'http://127.0.0.1:8188').replace(/\/+$/, '');
}

/** Ping, so the UI can say "ComfyUI not running" instead of failing at generate. */
async function testKey({ comfyUrl, signal }) {
  const stats = await getJson(`${base(comfyUrl)}/system_stats`, { signal, timeoutMs: 5000 });
  const dev = stats?.devices?.[0]?.name || 'unknown device';
  return { ok: true, label: `connected — ${dev}` };
}

async function listModels() {
  // A local workflow IS the model choice, so there is nothing to enumerate.
  return [];
}

/** Uploads the input image so a LoadImage node can reference it by name. */
async function uploadImage({ comfyUrl, buffer, filename, signal }) {
  const form = new FormData();
  form.append('image', new Blob([buffer]), filename);
  form.append('overwrite', 'true');

  const res = await fetch(`${base(comfyUrl)}/upload/image`, {
    method: 'POST',
    body: form,
    signal,
  });
  if (!res.ok) throw new Error(`ComfyUI rejected the image upload (HTTP ${res.status}).`);
  const json = await res.json();
  // Subfolder matters: LoadImage wants "sub/name.png" when one is used.
  return json.subfolder ? `${json.subfolder}/${json.name}` : json.name;
}

/** Walks the workflow replacing placeholder tokens in every string value. */
function substitute(node, values) {
  if (typeof node === 'string') {
    return node
      .replace(/%PROMPT%/g, values.prompt)
      .replace(/%IMAGE%/g, values.image)
      .replace(/%SEED%/g, String(values.seed));
  }
  if (Array.isArray(node)) return node.map((n) => substitute(n, values));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substitute(v, values)]));
  }
  return node;
}

/** Numeric seed fields cannot take a string, so fix those up separately. */
function coerceSeeds(workflow, seed) {
  for (const node of Object.values(workflow)) {
    const inputs = node?.inputs;
    if (!inputs) continue;
    for (const field of ['seed', 'noise_seed']) {
      if (inputs[field] === '%SEED%' || inputs[field] === String(seed)) inputs[field] = seed;
    }
  }
  return workflow;
}

async function generate({ comfyUrl, comfyWorkflow, prompt, imageBuffer, signal, onStage }) {
  if (!comfyWorkflow) {
    throw new Error(
      'No ComfyUI workflow selected. In ComfyUI use Workflow > Export (API) and pick that file in Settings.',
    );
  }
  let workflow;
  try {
    workflow = JSON.parse(fs.readFileSync(comfyWorkflow, 'utf8'));
  } catch (e) {
    throw new Error(`Could not read the workflow file: ${e.message}`);
  }
  if (workflow.nodes) {
    throw new Error(
      'That looks like a normal ComfyUI save, not an API export. Use Workflow > Export (API).',
    );
  }

  let imageName = '';
  if (imageBuffer) {
    onStage?.('Uploading input image…');
    imageName = await uploadImage({
      comfyUrl,
      buffer: imageBuffer,
      filename: `beeld-${Date.now()}.png`,
      signal,
    });
  }

  const seed = Math.floor(Math.random() * 2 ** 31);
  const prepared = coerceSeeds(substitute(workflow, { prompt, image: imageName, seed }), seed);

  onStage?.('Queued in ComfyUI…');
  const queued = await postJson(
    `${base(comfyUrl)}/prompt`,
    { prompt: prepared, client_id: 'beeld' },
    { signal, timeoutMs: 30_000 },
  );
  const id = queued?.prompt_id;
  if (!id) throw new Error('ComfyUI did not return a prompt id.');

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let entry = null;
  for (;;) {
    if (Date.now() > deadline) throw new Error('ComfyUI did not finish within 30 minutes.');
    await sleep(POLL_MS, signal);
    const hist = await getJson(`${base(comfyUrl)}/history/${id}`, { signal, timeoutMs: 15_000 });
    entry = hist?.[id];
    if (entry?.status?.completed) break;
    if (entry?.status?.status_str === 'error') {
      throw new Error('The ComfyUI workflow errored — check the ComfyUI console for the failing node.');
    }
    onStage?.('Generating locally…');
  }

  const images = [];
  for (const out of Object.values(entry.outputs || {})) {
    for (const img of out.images || []) {
      if (img.type === 'temp') continue;   // previews, not results
      const q = new URLSearchParams({
        filename: img.filename,
        subfolder: img.subfolder || '',
        type: img.type || 'output',
      });
      const data = await getBuffer(`${base(comfyUrl)}/view?${q}`, { signal });
      images.push({ data, ext: (img.filename.split('.').pop() || 'png').toLowerCase() });
    }
  }
  if (!images.length) throw new Error('The workflow finished but produced no saved image (is there a SaveImage node?).');

  return { images, meta: { approxCost: 0, model: 'local workflow', seed } };
}

module.exports = {
  id: 'comfy',
  testKey,
  listModels,
  generate,
  _substitute: substitute,
  _coerceSeeds: coerceSeeds,
};
