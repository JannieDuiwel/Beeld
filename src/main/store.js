'use strict';
/**
 * Settings and generation-history persistence.
 *
 * Hand-rolled rather than pulling in electron-store: it is a few dozen lines,
 * has no dependency surface, and lets us do atomic writes (write temp, rename)
 * so a crash mid-save cannot leave a truncated settings file that bricks the app.
 *
 * The data directory is injected rather than read from electron's `app`, so the
 * tests can drive this against a temp folder without booting Electron.
 *
 * API keys deliberately do NOT live here - see secrets.js. settings.json is
 * plain text and gets synced around; keys belong behind safeStorage.
 */

const fs = require('fs');
const path = require('path');

const HISTORY_CAP = 300;         // default; overridden by settings.historyMax
const HISTORY_HARD_MAX = 5000;   // ceiling, so a typo cannot make the file unbounded

const DEFAULTS = {
  // --- backend -------------------------------------------------------------
  // OpenRouter first because it is the only one you can try with no card at
  // all. The picker explains the trade-off; see shared/models.js blurbs.
  provider: 'openrouter',
  model: '',                     // '' = pick the first model of the provider
  comfyUrl: 'http://127.0.0.1:8188',
  comfyWorkflow: '',             // absolute path to a workflow saved in API format

  // --- prompting -----------------------------------------------------------
  preset: 'archviz-day',

  // Prompt assistance runs on OpenRouter's free tier. `openrouter/free` is the
  // Free Models Router: $0, and it accepts image input, so it can read the
  // SketchUp export and describe it. It still needs an OpenRouter key - free
  // means unpriced, not unauthenticated.
  // A NAMED instruction-tuned vision model, not `openrouter/free`. The router
  // can land on a guard model - nvidia/nemotron-3.5-content-safety:free is both
  // free and vision-capable - which answers "User Safety: safe" to everything.
  assistModel: 'google/gemma-4-31b-it:free',
  assistUsesImage: true,
  lastPrompt: '',
  negativePrompt: '',            // only some backends honour this; UI hides it otherwise

  // --- generation ----------------------------------------------------------
  // Left empty so each model's own defaults (shared/models.js) apply. A value
  // here is an explicit override the user set with a slider.
  params: {},
  numOutputs: 1,

  // --- input ---------------------------------------------------------------
  // Replicate takes file inputs as data URIs, and a 20 MB SketchUp export
  // becomes a 27 MB base64 string that is slow to upload and often rejected.
  // Downscaling the long edge first costs nothing visually at these model
  // resolutions (they cap around 1440px anyway).
  maxInputEdge: 1536,

  // --- output --------------------------------------------------------------
  // png because these outputs get opened in image editors; webp (the provider
  // default) still trips up older tools on Windows.
  outputFormat: 'png',
  saveDir: '',                   // '' = <Pictures>/Beeld (see main.js rendersDir)
  autoSave: true,

  // --- history -------------------------------------------------------------
  historyEnabled: true,
  historyMax: HISTORY_CAP,

  // --- game assets ---------------------------------------------------------
  godotProject: '',              // folder containing project.godot
  godotSubdir: 'assets',

  // --- interface -----------------------------------------------------------
  theme: 'dark',
  confirmOverSpend: 0.5,         // warn before a single run priced above this (USD); 0 disables
};

let dir = null;
let settingsPath = null;
let historyPath = null;
let cache = null;
let history = null;

function init(dataDir) {
  dir = dataDir;
  settingsPath = path.join(dir, 'settings.json');
  historyPath = path.join(dir, 'history.json');
  fs.mkdirSync(dir, { recursive: true });
  cache = null;
  history = null;
  return module.exports;
}

/** Write via temp + rename so an interrupted write cannot truncate the real file. */
function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    // Missing is normal on first run. Corrupt is not, but the only useful
    // recovery is to fall back to defaults rather than refuse to start.
    return fallback;
  }
}

// Assist models that can never write a prompt, whatever they are asked. A
// setting already saved pointing at one is repaired on load rather than left to
// fail confusingly every time the Improve button is pressed.
const BAD_ASSIST = /guard|content-safety|safety|moderat|classif|shield/i;

function settings() {
  if (!cache) {
    cache = { ...DEFAULTS, ...readJson(settingsPath, {}) };
    if (BAD_ASSIST.test(cache.assistModel || '')) cache.assistModel = DEFAULTS.assistModel;
  }
  return cache;
}

function setSettings(patch) {
  const next = { ...settings(), ...(patch || {}) };

  // Clamp the things a bad value would actually break.
  next.historyMax = Math.min(HISTORY_HARD_MAX, Math.max(1, Number(next.historyMax) || HISTORY_CAP));
  next.maxInputEdge = Math.min(4096, Math.max(256, Number(next.maxInputEdge) || 1536));
  next.numOutputs = Math.min(4, Math.max(1, Number(next.numOutputs) || 1));
  next.confirmOverSpend = Math.max(0, Number(next.confirmOverSpend) || 0);

  cache = next;
  writeAtomic(settingsPath, cache);
  return cache;
}

function resetSettings() {
  cache = { ...DEFAULTS };
  writeAtomic(settingsPath, cache);
  return cache;
}

function all() {
  if (!history) history = readJson(historyPath, []);
  return Array.isArray(history) ? history : [];
}

function addHistory(entry) {
  if (!settings().historyEnabled) return null;
  const rec = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    ...entry,
  };
  history = [rec, ...all()].slice(0, settings().historyMax);
  writeAtomic(historyPath, history);
  return rec;
}

function getHistory(limit) {
  const list = all();
  return limit ? list.slice(0, limit) : list;
}

function deleteHistory(id) {
  history = all().filter((h) => h.id !== id);
  writeAtomic(historyPath, history);
  return history.length;
}

/**
 * Rewrites the saved file paths of every history entry through `fn`. Used when
 * renders are relocated, so old thumbnails keep resolving instead of silently
 * pointing at files that have moved.
 */
function remapHistoryPaths(fn) {
  const list = all();
  let changed = 0;
  for (const rec of list) {
    if (!Array.isArray(rec.paths)) continue;
    rec.paths = rec.paths.map((p) => {
      const next = fn(p);
      if (next !== p) changed++;
      return next;
    });
  }
  if (changed) {
    history = list;
    writeAtomic(historyPath, history);
  }
  return changed;
}

function clearHistory() {
  history = [];
  writeAtomic(historyPath, history);
  return 0;
}

module.exports = {
  DEFAULTS,
  init,
  settings,
  setSettings,
  resetSettings,
  addHistory,
  getHistory,
  deleteHistory,
  clearHistory,
  remapHistoryPaths,
};
