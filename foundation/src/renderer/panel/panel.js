'use strict';
/**
 * Renderer logic.
 *
 * Plain DOM, no framework, no build step. For a single window of form controls
 * that is not a limitation - it is the reason `git clone && npm start` works
 * with nothing to compile and nothing to keep up to date.
 *
 * Reach for a framework when the UI has genuine component reuse or derived
 * state that is painful to keep in sync by hand. A settings panel is neither.
 *
 * State of record lives in main (settings.json). This file holds only what is
 * transient and would be meaningless to persist.
 */

const api = window.app;

const el = (id) => document.getElementById(id);
const ui = {
  note: el('note'),
  work: el('work'),
  reset: el('reset'),
  count: el('count'),
  status: el('status'),
};

let state = null;   // last snapshot from main
let busy = false;

// --- rendering -------------------------------------------------------------

function render() {
  // Do not clobber what the user is mid-way through typing.
  if (document.activeElement !== ui.note) ui.note.value = state.settings.note || '';
  ui.count.textContent = `${state.settings.runCount} run${state.settings.runCount === 1 ? '' : 's'}`;
}

function setStatus(text, kind = '') {
  ui.status.textContent = text;
  ui.status.className = `status ${kind}`.trim();
}

function setBusy(on) {
  busy = on;
  ui.work.disabled = on;
  ui.reset.disabled = on;
}

// --- actions ---------------------------------------------------------------

/** Every mutation goes through main and refreshes from what main returns. */
async function save(patch) {
  state = await api.setSettings(patch);
  render();
}

async function doWork() {
  if (busy) return;
  setBusy(true);
  setStatus('Starting…');

  const res = await api.doWork();

  setBusy(false);
  if (!res.ok) {
    setStatus(res.error || 'Something went wrong.', 'bad');
    return;
  }
  state = await api.getState();
  render();
  setStatus('Done.', 'ok');
}

// --- wiring ----------------------------------------------------------------

// 'change' rather than 'input': one write when the field is left, not one per
// keystroke.
ui.note.addEventListener('change', () => save({ note: ui.note.value }));

ui.work.addEventListener('click', doWork);

ui.reset.addEventListener('click', async () => {
  state = await api.resetSettings();
  render();
  setStatus('Settings reset to defaults.', 'ok');
});

api.onProgress((text) => {
  if (busy) setStatus(text);
});

// --- boot ------------------------------------------------------------------

(async function boot() {
  state = await api.getState();
  render();
})();
