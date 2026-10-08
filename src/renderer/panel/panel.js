'use strict';
/**
 * Renderer logic.
 *
 * Plain DOM, no framework - the same call it was right to make in Vloei. The
 * whole surface is one form and one image, and a build step would cost more
 * than it saves.
 *
 * State lives in main (settings.json); this file holds only what is transient:
 * the chosen input image and the last result.
 */

const api = window.beeld;

const el = (id) => document.getElementById(id);
const ui = {
  provider: el('provider'), providerHint: el('providerHint'),
  model: el('model'), modelHint: el('modelHint'),
  imageField: el('imageField'), drop: el('drop'),
  dropEmpty: el('dropEmpty'), dropFilled: el('dropFilled'),
  preview: el('preview'), imageMeta: el('imageMeta'), imageHint: el('imageHint'),
  clearImage: el('clearImage'),
  prompt: el('prompt'), preset: el('preset'), presetHint: el('presetHint'),
  improve: el('improve'), improveHint: el('improveHint'),
  improveUndoRow: el('improveUndoRow'), improveUndo: el('improveUndo'),
  assistModel: el('assistModel'),
  params: el('params'),
  go: el('go'), stop: el('stop'),
  stage: el('stage'), empty: el('empty'),
  stageText: el('stageText'), costText: el('costText'),
  saveAs: el('saveAs'), saveAll: el('saveAll'), reveal: el('reveal'),
  strip: el('strip'), headerSub: el('headerSub'),
  settings: el('settings'), provList: el('provList'),
  keyStorageNote: el('keyStorageNote'), saveDirNote: el('saveDirNote'),
  maxEdge: el('maxEdge'),
  openSettings: el('openSettings'), closeSettings: el('closeSettings'),
  openRenders: el('openRenders'), clearHistory: el('clearHistory'),
};

let state = null;        // last snapshot from main
let models = [];         // models for the current provider
let input = null;        // { path, name, dataUri, ... }
let result = null;       // last successful generation
let selected = 0;        // which result image Save as / Show file act on
let busy = false;

// --- rendering -------------------------------------------------------------

function currentModel() {
  return models.find((m) => m.id === ui.model.value) || null;
}

function fillSelect(select, items, value) {
  select.innerHTML = '';
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = it.id;
    opt.textContent = it.label;
    select.appendChild(opt);
  }
  if (value && items.some((i) => i.id === value)) select.value = value;
}

function renderProviders() {
  fillSelect(ui.provider, state.providers, state.settings.provider);
  const p = state.providers.find((x) => x.id === ui.provider.value);
  ui.providerHint.textContent = p ? p.blurb : '';
  renderImproveAvailability();
}

/**
 * Improve always runs on OpenRouter's free tier, whatever renders the image.
 * That is easy to miss when the backend is Replicate or ComfyUI, so say it here
 * rather than letting the first click be an error.
 */
function renderImproveAvailability() {
  const hasKey = Boolean(state.keys?.openrouter);
  ui.improve.disabled = !hasKey || busy;
  ui.improve.title = hasKey
    ? 'Rewrite this with a free model — costs nothing'
    : 'Needs an OpenRouter key (Settings). Free, but still needs a key.';
  if (!hasKey) {
    ui.improveHint.textContent = 'Improve needs an OpenRouter key — free to use.';
    ui.improveHint.className = 'field__hint';
  } else if (/needs an OpenRouter key/.test(ui.improveHint.textContent)) {
    ui.improveHint.textContent = '';
  }
}

function renderModels() {
  fillSelect(ui.model, models, state.settings.model);
  renderModelDetail();
}

function renderModelDetail() {
  const m = currentModel();
  ui.modelHint.textContent = m ? (m.blurb || '') : 'No models — see Settings.';

  // The image field is the clearest signal of what a model actually does, so
  // it changes shape rather than just enabling/disabling.
  const kind = m?.kind || 'text2img';
  ui.imageField.hidden = kind === 'text2img';
  ui.imageHint.textContent =
    kind === 'structure'
      ? 'Required. Its geometry is kept; the prompt decides materials and light.'
      : kind === 'edit'
        ? 'Optional. Used as the subject — write the prompt as an instruction.'
        : '';
  ui.imageHint.className = 'field__hint';

  renderParams();
  renderCost();
}

function renderParams() {
  const m = currentModel();
  ui.params.innerHTML = '';
  if (!m?.controls?.length) return;

  const label = document.createElement('span');
  label.className = 'field__label';
  label.textContent = 'Settings';
  ui.params.appendChild(label);

  for (const name of m.controls) {
    if (name === 'seed') continue;                 // random per run; not worth a slider
    const range = m.ranges?.[name];
    if (!range) continue;

    // Params are stored once for all models, so a value carried over from a
    // model with a wider range has to be clamped for display too - otherwise
    // the slider sits at the max while the number beside it reads 30.
    const raw = state.settings.params?.[name] ?? m.defaults?.[name] ?? range[0];
    const value = Math.min(range[1], Math.max(range[0], Number(raw)));

    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.innerHTML =
      `<div class="field__head"><span class="field__label">${labelFor(name)}</span><span class="field__value" data-out>${value}</span></div>`;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'range';
    slider.min = range[0];
    slider.max = range[1];
    slider.step = name === 'guidance' ? 0.5 : 1;
    slider.value = value;
    // The kit draws the filled part of the track from --fill.
    const fill = () => slider.style.setProperty('--fill', `${((slider.value - range[0]) / (range[1] - range[0])) * 100}%`);
    fill();

    const out = wrap.querySelector('[data-out]');
    slider.addEventListener('input', () => { out.textContent = slider.value; fill(); });
    slider.addEventListener('change', () => {
      const params = { ...(state.settings.params || {}), [name]: Number(slider.value) };
      save({ params });
      if (name === 'num_outputs') renderCost();
    });

    wrap.appendChild(slider);
    ui.params.appendChild(wrap);
  }
}

function labelFor(name) {
  return {
    guidance: 'Prompt adherence',
    num_inference_steps: 'Steps (quality vs speed)',
    num_outputs: 'Images per run',
    aspect_ratio: 'Aspect ratio',
  }[name] || name.replace(/_/g, ' ');
}

function renderCost() {
  const m = currentModel();
  const n = Number(state.settings.params?.num_outputs || 1);
  if (!m?.approxCost) { ui.costText.textContent = ''; return; }
  const total = m.approxCost * (m.controls?.includes('num_outputs') ? n : 1);
  ui.costText.textContent = `≈ $${total.toFixed(3)} per run`;
}

function renderPresets() {
  fillSelect(ui.preset, state.presets, state.settings.preset);
  const p = state.presets.find((x) => x.id === ui.preset.value);
  ui.presetHint.textContent = p ? p.hint : '';
}

function renderImage() {
  const has = Boolean(input);
  ui.dropEmpty.hidden = has;
  ui.dropFilled.hidden = !has;
  ui.clearImage.hidden = !has;
  ui.drop.classList.toggle('drop--loaded', has);
  if (!has) return;

  ui.preview.src = input.dataUri;
  const kb = Math.round(input.bytes / 1024);
  ui.imageMeta.textContent = input.resized
    ? `${input.name} — ${input.originalWidth}×${input.originalHeight} → ${input.width}×${input.height}, ${kb} KB`
    : `${input.name} — ${input.width}×${input.height}, ${kb} KB`;
}

function showStage(node) {
  ui.stage.innerHTML = '';
  ui.stage.appendChild(node);
}

function showEmpty() {
  showStage(ui.empty);
  result = null;
  ui.saveAs.hidden = true;
  ui.saveAll.hidden = true;
  ui.reveal.hidden = true;
}

function showBusy(text) {
  // Stage updates arrive several times per run. Replacing the node each time
  // restarts the spinner's CSS animation, so update the caption in place when
  // one is already on screen.
  const existing = ui.stage.querySelector('.busy [data-caption]');
  if (existing) {
    existing.textContent = text || 'Working…';
    return;
  }
  const div = document.createElement('div');
  div.className = 'busy';
  div.innerHTML = `<div class="spinner"></div><div data-caption></div>`;
  div.querySelector('[data-caption]').textContent = text || 'Working…';
  showStage(div);
}

function showError(msg) {
  const div = document.createElement('div');
  div.className = 'notice notice--err stage-error';
  div.innerHTML = '<svg class="icon notice__icon"><use href="#i-alert"/></svg><div class="notice__body"></div>';
  div.querySelector('.notice__body').textContent = msg;   // textContent: the message is not HTML
  showStage(div);
  ui.saveAs.hidden = true;
  ui.saveAll.hidden = true;
  ui.reveal.hidden = true;
}

function showResult(res) {
  result = res;
  selected = 0;

  const multi = res.images.length > 1;
  const wrap = document.createElement('div');
  wrap.className = multi ? 'results multi' : 'results';

  res.images.forEach((img, i) => {
    const node = document.createElement('img');
    node.src = imgSrc(img);
    node.alt = res.prompt;
    // Small pixel-art results would otherwise render as a speck. Scale them up
    // in whole steps with nearest-neighbour so the pixels stay crisp.
    node.addEventListener('load', () => {
      const longest = Math.max(node.naturalWidth, node.naturalHeight);
      if (longest && longest < 400) {
        const k = Math.max(1, Math.floor(400 / longest));
        node.classList.add('px');
        node.style.width = `${node.naturalWidth * k}px`;
        node.style.maxWidth = 'none';
      }
    });
    if (i === 0) node.classList.add('sel');
    // With more than one result, Save as / Show file need to know WHICH one.
    // Previously they always acted on images[0], so a second image could be
    // seen but never saved.
    node.addEventListener('click', () => {
      selected = i;
      wrap.querySelectorAll('img').forEach((n, j) => n.classList.toggle('sel', j === i));
      updateSaveButtons();
    });
    wrap.appendChild(node);
  });

  showStage(wrap);
  updateSaveButtons();

  const cost = res.meta?.approxCost;
  const time = res.meta?.predictTime;
  ui.costText.textContent = [
    cost != null ? `$${Number(cost).toFixed(4)}` : null,
    time != null ? `${Number(time).toFixed(1)}s` : null,
  ].filter(Boolean).join(' · ') || '';
}

/** Save buttons follow the selection, and "Save all" only exists when it means something. */
function updateSaveButtons() {
  const n = result?.images?.length || 0;
  ui.saveAs.hidden = n === 0;
  ui.saveAll.hidden = n < 2;
  ui.saveAs.textContent = n > 1 ? `Save #${selected + 1}…` : 'Save as…';
  ui.reveal.hidden = !result?.images?.[selected]?.path;
}

/** History items and opened files carry a path but no pixels; show them from disk. */
function imgSrc(img) {
  return img.dataUri || `file:///${String(img.path).replace(/\\/g, '/')}`;
}

function escape(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

async function renderHistory() {
  const list = await api.getHistory(30);
  ui.strip.innerHTML = '';
  if (!list.length) {
    ui.strip.innerHTML = '<span class="strip-bar__empty">No history yet.</span>';
    return;
  }
  for (const h of list) {
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'thumb';
    thumb.setAttribute('aria-selected', 'false');
    thumb.title = `${h.prompt}\n${h.model}\n(click to use, double-click to show file)`;
    if (h.provider === 'tools') thumb.classList.add('thumb--tool');
    const img = document.createElement('img');
    img.alt = '';
    thumb.appendChild(img);
    // History holds paths, not pixels, so a deleted file simply shows blank
    // rather than bloating history.json with base64.
    if (h.paths?.[0]) img.src = `file:///${h.paths[0].replace(/\\/g, '/')}`;
    // Click loads it onto the stage, where the Game tools act on it - so any
    // earlier render, or a tool's output, can be picked up again. Double-click
    // shows the file in Explorer.
    thumb.addEventListener('click', () => {
      if (!h.paths?.[0]) return;
      if (h.provider !== 'tools') ui.prompt.value = h.prompt;
      showResult({ prompt: h.prompt, images: [{ path: h.paths[0] }], meta: h.meta || {} });
      ui.strip.querySelectorAll('.thumb').forEach((t) => t.setAttribute('aria-selected', String(t === thumb)));
    });
    thumb.addEventListener('dblclick', () => { if (h.paths?.[0]) api.reveal(h.paths[0]); });
    ui.strip.appendChild(thumb);
  }
}

function setBusy(on) {
  busy = on;
  ui.go.disabled = on;
  ui.stop.hidden = !on;
  ui.provider.disabled = on;
  ui.model.disabled = on;
  if (!on) renderImproveAvailability(); else ui.improve.disabled = true;
  if (!on) ui.stageText.textContent = '';
}

// --- actions ---------------------------------------------------------------

async function save(patch) {
  state = await api.setSettings(patch);
  return state;
}

async function loadModels() {
  ui.model.innerHTML = '<option>Loading…</option>';
  const res = await api.listModels(ui.provider.value);
  models = res.models || [];
  if (!res.ok && res.error) ui.modelHint.textContent = res.error;
  renderModels();
}

async function onProviderChange() {
  await save({ provider: ui.provider.value, model: '' });
  renderProviders();
  await loadModels();
  if (models.length) await save({ model: ui.model.value });
}

async function pickImage() {
  const res = await api.pickImage();
  if (!res) return;
  if (!res.ok) { ui.imageHint.textContent = res.error; ui.imageHint.className = 'field__hint field__hint--warn'; return; }
  input = res;
  renderImage();
}

async function generate() {
  const m = currentModel();
  if (!m) { showError('Pick a model first.'); return; }
  if (m.kind === 'structure' && !input) {
    ui.imageHint.textContent = 'This model needs an input image to work from.';
    ui.imageHint.className = 'field__hint field__hint--warn';
    return;
  }
  if (!ui.prompt.value.trim()) { ui.prompt.focus(); return; }

  setBusy(true);
  showBusy('Starting…');

  const res = await api.generate({
    provider: ui.provider.value,
    model: ui.model.value,
    prompt: ui.prompt.value,
    preset: ui.preset.value,
    imagePath: input?.path || null,
    params: state.settings.params || {},
    numOutputs: state.settings.params?.num_outputs || 1,
  });

  setBusy(false);

  if (res.cancelled) { showEmpty(); return; }
  if (!res.ok) { showError(res.error || 'Generation failed.'); return; }

  showResult(res);
  renderHistory();
}

// --- prompt assistance -----------------------------------------------------

/**
 * Rewrites the prompt using OpenRouter's free tier.
 *
 * Free models output text only - none of them can generate a picture - so this
 * is the one place they genuinely help. When the chosen model has vision and
 * there is an input image, it reads the image and describes the actual building
 * rather than guessing from the typed words.
 *
 * The previous prompt is kept so a bad rewrite is one click away from undone;
 * losing what you typed to a model you did not ask to be creative is annoying.
 */
let promptBeforeImprove = null;

async function improvePrompt() {
  if (busy) return;

  ui.improve.disabled = true;
  ui.improve.textContent = '✦ Thinking…';
  ui.improveHint.textContent = input ? 'Reading your image…' : 'Rewriting…';
  ui.improveHint.className = 'field__hint';

  const before = ui.prompt.value;
  const res = await api.enhancePrompt(before, input?.path || null);

  ui.improve.disabled = false;
  ui.improve.textContent = '✦ Improve';

  if (!res.ok) {
    ui.improveHint.textContent = res.error;
    ui.improveHint.className = 'field__hint field__hint--err';
    return;
  }

  promptBeforeImprove = before;
  ui.prompt.value = res.prompt;
  ui.improveUndoRow.hidden = false;
  await save({ lastPrompt: res.prompt });

  const cost = Number(res.cost || 0);
  ui.improveHint.textContent =
    `Rewritten by ${res.model}${cost > 0 ? ` — $${cost.toFixed(4)}` : ' — free'}`;
  ui.improveHint.className = 'field__hint field__hint--ok';
}

function undoImprove() {
  if (promptBeforeImprove === null) return;
  ui.prompt.value = promptBeforeImprove;
  promptBeforeImprove = null;
  ui.improveUndoRow.hidden = true;
  ui.improveHint.textContent = '';
  ui.improveHint.className = 'field__hint';
  save({ lastPrompt: ui.prompt.value });
}

async function loadAssistModels() {
  const res = await api.listFreeModels();
  const list = res.models || [];
  ui.assistModel.innerHTML = '';

  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = state.settings.assistModel;
    opt.textContent = state.settings.assistModel + ' (list unavailable)';
    ui.assistModel.appendChild(opt);
    return;
  }

  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.vision ? `${m.label} — sees images` : m.label;
    ui.assistModel.appendChild(opt);
  }
  if (list.some((m) => m.id === state.settings.assistModel)) {
    ui.assistModel.value = state.settings.assistModel;
  }
}

// --- settings modal --------------------------------------------------------

function renderSettings() {
  ui.keyStorageNote.textContent = state.keysPersist
    ? 'Keys are encrypted with your Windows account and stay put between launches.'
    : 'Encrypted storage is unavailable, so keys last only until you close the app.';

  ui.saveDirNote.textContent = state.rendersDir;
  ui.maxEdge.value = state.settings.maxInputEdge;
  ui.provList.innerHTML = '';

  for (const p of state.providers) {
    const has = Boolean(state.keys[p.id]);
    const box = document.createElement('div');
    box.className = 'prov';
    box.innerHTML = `
      <h3><span class="dot ${has || !p.needsKey ? 'on' : ''}"></span>${escape(p.label)}</h3>
      <p>${escape(p.blurb)}</p>`;

    if (p.needsKey) {
      const row = document.createElement('div');
      row.className = 'prov-row';
      const field = document.createElement('input');
      field.type = 'password';
      field.className = 'input';
      field.placeholder = has ? '•••••••• (saved)' : p.keyHint;
      row.appendChild(field);

      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn btn--sm';
      saveBtn.textContent = 'Save';
      row.appendChild(saveBtn);

      const testBtn = document.createElement('button');
      testBtn.className = 'btn btn--sm btn--ghost';
      testBtn.textContent = 'Test';
      row.appendChild(testBtn);

      box.appendChild(row);

      const status = document.createElement('div');
      status.className = 'status';
      box.appendChild(status);

      const link = document.createElement('div');
      link.className = 'field__hint';
      link.innerHTML = `<a data-url="${p.keyUrl}">Get a key →</a>`;
      box.appendChild(link);

      saveBtn.addEventListener('click', async () => {
        state = await api.setKey(p.id, field.value);
        field.value = '';
        status.textContent = 'Saved.';
        status.className = 'status ok';
        renderSettings();
        renderImproveAvailability();
      });

      testBtn.addEventListener('click', async () => {
        status.textContent = 'Checking…';
        status.className = 'status';
        const r = await api.testKey(p.id);
        status.textContent = r.label;
        status.className = `status ${r.ok ? 'ok' : 'bad'}`;
      });
    } else {
      // ComfyUI needs a URL rather than a key.
      const row = document.createElement('div');
      row.className = 'prov-row';
      const field = document.createElement('input');
      field.type = 'text';
      field.className = 'input';
      field.value = state.settings.comfyUrl;
      row.appendChild(field);

      const testBtn = document.createElement('button');
      testBtn.className = 'btn btn--sm btn--ghost';
      testBtn.textContent = 'Test';
      row.appendChild(testBtn);
      box.appendChild(row);

      const status = document.createElement('div');
      status.className = 'status';
      box.appendChild(status);

      field.addEventListener('change', () => save({ comfyUrl: field.value }));
      testBtn.addEventListener('click', async () => {
        await save({ comfyUrl: field.value });
        status.textContent = 'Checking…';
        status.className = 'status';
        const r = await api.testKey(p.id);
        status.textContent = r.label;
        status.className = `status ${r.ok ? 'ok' : 'bad'}`;
      });
    }

    ui.provList.appendChild(box);
  }

  ui.provList.querySelectorAll('a[data-url]').forEach((a) =>
    a.addEventListener('click', () => api.openExternal(a.dataset.url)));
}

// --- wiring ----------------------------------------------------------------

ui.provider.addEventListener('change', onProviderChange);
ui.model.addEventListener('change', async () => {
  await save({ model: ui.model.value });
  renderModelDetail();
});
ui.preset.addEventListener('change', async () => {
  await save({ preset: ui.preset.value });
  renderPresets();
});
ui.prompt.addEventListener('change', () => save({ lastPrompt: ui.prompt.value }));

// Ctrl+Enter generates, because the prompt box swallows plain Enter.
ui.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !busy) generate();
});

ui.drop.addEventListener('click', pickImage);
ui.clearImage.addEventListener('click', (e) => {
  e.stopPropagation();
  input = null;
  renderImage();
});

['dragenter', 'dragover'].forEach((ev) =>
  ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.add('is-dragover'); }));
['dragleave', 'drop'].forEach((ev) =>
  ui.drop.addEventListener(ev, () => ui.drop.classList.remove('is-dragover')));

ui.drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  // webUtils (via the beeldPath bridge) is the supported way to get a dropped
  // file's real path; file.path only exists on older Electron.
  const p = window.beeldPath?.(file) || file.path;
  if (!p) { ui.imageHint.textContent = 'Could not read that file — use the click-to-choose route.'; return; }
  const res = await api.loadImage(p);
  if (!res.ok) { ui.imageHint.textContent = res.error; ui.imageHint.className = 'field__hint field__hint--warn'; return; }
  input = res;
  renderImage();
});

ui.improve.addEventListener('click', improvePrompt);
ui.improveUndo.addEventListener('click', undoImprove);

// A hand-typed edit means the undo snapshot is stale.
ui.prompt.addEventListener('input', () => {
  if (promptBeforeImprove !== null && ui.prompt.value !== promptBeforeImprove) {
    ui.improveUndoRow.hidden = true;
    promptBeforeImprove = null;
  }
});

ui.go.addEventListener('click', generate);
ui.stop.addEventListener('click', () => api.cancel());

ui.saveAs.addEventListener('click', async () => {
  const img = result?.images?.[selected];
  if (!img) return;
  const n = result.images.length > 1 ? `-${selected + 1}` : '';
  await api.saveAs(img.dataUri, `render${n}.png`, img.path);
});

ui.saveAll.addEventListener('click', async () => {
  if (!result?.images?.length) return;
  const written = await api.saveAll(result.images.filter((i) => i.dataUri).map((i) => i.dataUri), result.prompt);
  if (written?.length) {
    ui.stageText.textContent = `Saved ${written.length} images.`;
  }
});

/**
 * Both of these open Explorer. They report what happened in the status bar
 * because a silent action that opens a window behind this one is
 * indistinguishable from a broken button.
 */
async function reveal(file) {
  const res = await api.reveal(file || null);
  if (!res) return;
  if (res.ok) {
    ui.stageText.textContent = res.empty
      ? `Renders folder is empty yet — ${res.dir}`
      : `Opened ${res.dir || 'the folder'}`;
  } else {
    ui.stageText.textContent = `Could not open the folder: ${res.error || 'unknown error'}`;
  }
}

ui.reveal.addEventListener('click', () => reveal(result?.images?.[selected]?.path));
ui.openRenders.addEventListener('click', () => reveal(null));

ui.openSettings.addEventListener('click', () => {
  renderSettings();
  loadAssistModels();
  ui.settings.classList.add('open');
});
ui.assistModel.addEventListener('change', () => {
  const opt = ui.assistModel.selectedOptions[0];
  save({
    assistModel: ui.assistModel.value,
    // Sending an image to a text-only model is an outright rejection, so the
    // capability is recorded alongside the choice rather than re-derived later.
    assistUsesImage: /sees images/.test(opt ? opt.textContent : ''),
  });
});
ui.closeSettings.addEventListener('click', () => ui.settings.classList.remove('open'));
ui.settings.addEventListener('click', (e) => {
  if (e.target === ui.settings) ui.settings.classList.remove('open');
});
ui.maxEdge.addEventListener('change', () => save({ maxInputEdge: Number(ui.maxEdge.value) }));
ui.clearHistory.addEventListener('click', async () => {
  await api.clearHistory();
  renderHistory();
});

api.onStage((text) => {
  ui.stageText.textContent = text;
  if (busy) showBusy(text);
});

// --- boot ------------------------------------------------------------------

(async function boot() {
  state = await api.getState();
  renderProviders();
  renderPresets();
  ui.prompt.value = state.settings.lastPrompt || '';
  await loadModels();
  showEmpty();
  renderHistory();
  ui.headerSub.textContent = state.keysPersist
    ? 'Image generation, whichever backend you feel like'
    : 'Keys will not persist this session — see Settings';
})();
