'use strict';
/**
 * Main process: window, IPC, and the one generation pipeline every backend
 * funnels through.
 *
 * Deliberately the only place that knows about both settings and providers, so
 * the providers stay pure request/response modules that the tests can drive
 * without Electron.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const C = require('../shared/channels');
const { PROVIDERS, modelsFor } = require('../shared/models');
const { PRESETS, applyPreset } = require('../shared/presets');
const store = require('./store');
const secrets = require('./secrets');
const images = require('./images');
const providers = require('./providers');
const openrouter = require('./providers/openrouter');
const assetops = require('./assetops');
const updater = require('./updater');

const DEV = process.argv.includes('--dev');

let win = null;
let updates = null;
let running = null;      // { controller } while a generation is in flight

// --- window ----------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0d0d12',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'panel.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'panel', 'index.html'));
  win.once('ready-to-show', () => win.show());

  if (DEV) {
    win.webContents.openDevTools({ mode: 'detach' });

    // A throw while wiring listeners silently kills every listener after it,
    // which presents as "that button does nothing". Forwarding renderer errors
    // to the terminal makes that visible instead of mysterious.
    // The signature changed across Electron versions: older builds pass
    // positional args, newer ones a details object.
    win.webContents.on('console-message', (...args) => {
      const d = typeof args[1] === 'object' ? args[1] : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
      const level = String(d.level);
      if (level === 'error' || level === 'warning' || Number(d.level) >= 2) {
        console.error(`[renderer] ${d.message} (${d.sourceId || '?'}:${d.lineNumber || 0})`);
      }
    });
  }

  // Anything that wants a new window is an external link (key pages, docs).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// --- helpers ---------------------------------------------------------------

/**
 * Where finished renders go.
 *
 * Pictures, NOT userData. Two reasons, and the second one bit us hard:
 *
 * 1. Generated images are the user's documents, not the app's state. AppData is
 *    for settings and keys.
 * 2. AppData can be VIRTUALIZED. Launched as a child of a packaged (MSIX) app,
 *    this process sees %APPDATA%\Beeld transparently redirected into that
 *    package's LocalCache. Beeld could read and write there perfectly well, but
 *    Explorer runs outside the container, so asking the shell to open the
 *    folder produced "Location is not available" for a path that demonstrably
 *    existed. Known folders such as Pictures are not redirected this way.
 */
function rendersDir() {
  return store.settings().saveDir || path.join(app.getPath('pictures'), 'Beeld');
}

/** Derived game assets (pixelated, cut out, sheets) live beside the renders. */
function assetsDir() {
  return path.join(app.getPath('pictures'), 'Beeld', 'Assets');
}

/** Where renders used to go, kept only so they can be moved out. */
function legacyRendersDir() {
  return path.join(app.getPath('userData'), 'renders');
}

/**
 * Moves renders out of the old userData location once, rewriting the history
 * entries that point at them. Without this, images made before the change are
 * stranded somewhere the user cannot browse to.
 */
function migrateRenders() {
  const from = legacyRendersDir();
  const to = rendersDir();
  if (!fs.existsSync(from)) return;

  let files;
  try {
    files = fs.readdirSync(from).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  } catch {
    return;
  }
  if (!files.length) return;

  fs.mkdirSync(to, { recursive: true });
  const moved = new Map();

  for (const name of files) {
    const src = path.join(from, name);
    let dest = path.join(to, name);
    let n = 2;
    while (fs.existsSync(dest)) {
      dest = path.join(to, name.replace(/(\.\w+)$/, `-${n++}$1`));
    }
    try {
      // Rename fails across volumes (Pictures may be on OneDrive), so fall
      // back to copy + unlink rather than losing the file.
      try { fs.renameSync(src, dest); } catch {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
      }
      moved.set(src, dest);
    } catch {
      // A file we cannot move is left where it is; better than aborting.
    }
  }

  if (moved.size) {
    store.remapHistoryPaths((p) => moved.get(p) || p);
    console.log(`Moved ${moved.size} render(s) to ${to}`);
  }
  try { fs.rmdirSync(from); } catch { /* not empty, fine */ }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Everything the renderer needs to draw itself, in one round trip. */
function state() {
  const s = store.settings();
  return {
    settings: s,
    providers: PROVIDERS,
    presets: PRESETS,
    models: modelsFor(s.provider),
    keys: secrets.status(),
    keysPersist: secrets.persistent(),
    rendersDir: rendersDir(),
    busy: Boolean(running),
    version: app.getVersion(),
    update: updates ? updates.status() : null,
    godotProject: store.settings().godotProject,
    godotSubdir: store.settings().godotSubdir,
    assetsDir: assetsDir(),
  };
}

// --- IPC: settings and keys ------------------------------------------------

ipcMain.handle(C.GET_STATE, () => state());

ipcMain.handle(C.SET_SETTINGS, (_e, patch) => {
  store.setSettings(patch);
  return state();
});

ipcMain.handle(C.RESET_SETTINGS, () => {
  store.resetSettings();
  return state();
});

ipcMain.handle(C.SET_KEY, (_e, { provider, key }) => {
  secrets.set(provider, key);
  return state();
});

ipcMain.handle(C.CLEAR_KEY, (_e, provider) => {
  secrets.clear(provider);
  return state();
});

ipcMain.handle(C.TEST_KEY, async (_e, providerId) => {
  try {
    const p = providers.get(providerId);
    const res = await p.testKey({
      key: secrets.get(providerId),
      comfyUrl: store.settings().comfyUrl,
    });
    return { ok: true, label: res.label };
  } catch (e) {
    return { ok: false, label: describe(e) };
  }
});

ipcMain.handle(C.LIST_MODELS, async (_e, providerId) => {
  try {
    const p = providers.get(providerId);
    const list = await p.listModels({ key: secrets.get(providerId) });
    // Providers that discover at runtime can come back empty if offline; fall
    // back to the static catalogue so the picker is never blank.
    return { ok: true, models: list.length ? list : modelsFor(providerId) };
  } catch (e) {
    return { ok: false, models: modelsFor(providerId), error: describe(e) };
  }
});

/**
 * Prompt assistance, always via OpenRouter's free tier regardless of which
 * backend will render the image - there is no reason to pay a rendering
 * provider for a paragraph of text.
 */
ipcMain.handle(C.LIST_FREE_MODELS, async () => {
  try {
    return { ok: true, models: await openrouter.listFreeModels({}) };
  } catch (e) {
    return { ok: false, models: [], error: describe(e) };
  }
});

ipcMain.handle(C.ENHANCE_PROMPT, async (_e, { prompt, imagePath }) => {
  const key = secrets.get('openrouter');
  if (!key) {
    return {
      ok: false,
      error: 'Prompt help runs on OpenRouter\'s free models, which still need a key.\nAdd one in Settings — it costs nothing to use.',
    };
  }

  const s = store.settings();
  try {
    // Only send the image when the chosen model can actually see one; a
    // text-only model would otherwise reject the request outright.
    let imageDataUri = null;
    if (imagePath && s.assistUsesImage) {
      imageDataUri = images.prepareInput(imagePath, Math.min(s.maxInputEdge, 1024)).dataUri;
    }

    const res = await openrouter.enhancePrompt({
      key,
      prompt,
      imageDataUri,
      model: s.assistModel,
    });
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: describe(e) };
  }
});

// --- IPC: images -----------------------------------------------------------

ipcMain.handle(C.PICK_IMAGE, async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose an input image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return loadImage(res.filePaths[0]);
});

ipcMain.handle(C.LOAD_IMAGE, (_e, file) => loadImage(file));

function loadImage(file) {
  try {
    const prepared = images.prepareInput(file, store.settings().maxInputEdge);
    return {
      ok: true,
      path: file,
      name: path.basename(file),
      dataUri: prepared.dataUri,
      width: prepared.width,
      height: prepared.height,
      resized: prepared.resized,
      originalWidth: prepared.originalWidth,
      originalHeight: prepared.originalHeight,
      bytes: prepared.bytes,
    };
  } catch (e) {
    return { ok: false, error: describe(e) };
  }
}

// --- IPC: generation -------------------------------------------------------

ipcMain.handle(C.GENERATE, async (_e, job) => {
  if (running) return { ok: false, error: 'A generation is already running.' };

  const s = store.settings();
  const controller = new AbortController();
  running = { controller };

  try {
    const prompt = applyPreset(job.prompt, job.preset);
    if (!prompt.trim()) throw new Error('Type a prompt first.');

    // Input image is re-prepared here rather than trusting the renderer's copy,
    // so the size cap is enforced in one place.
    let imageDataUri = null;
    let imageBuffer = null;
    if (job.imagePath) {
      const prepared = images.prepareInput(job.imagePath, s.maxInputEdge);
      imageDataUri = prepared.dataUri;
      imageBuffer = prepared.buffer;
    }

    const provider = providers.get(job.provider);
    const result = await provider.generate({
      key: secrets.get(job.provider),
      modelId: job.model,
      prompt,
      imageDataUri,
      imageBuffer,
      params: job.params || {},
      numOutputs: job.numOutputs || 1,
      outputFormat: s.outputFormat,
      comfyUrl: s.comfyUrl,
      comfyWorkflow: s.comfyWorkflow,
      signal: controller.signal,
      onStage: (text) => send(C.STAGE, text),
    });

    let saved = [];
    if (s.autoSave) {
      send(C.STAGE, 'Saving…');
      saved = images.saveAll(result.images, rendersDir(), prompt);
    }

    const payload = {
      ok: true,
      prompt,
      provider: job.provider,
      model: job.model,
      images: result.images.map((img, i) => ({
        dataUri: images.toDataUri(img),
        path: saved[i] || null,
      })),
      meta: result.meta || {},
    };

    store.addHistory({
      prompt,
      provider: job.provider,
      model: job.model,
      paths: saved,
      inputPath: job.imagePath || null,
      meta: result.meta || {},
    });
    store.setSettings({ lastPrompt: job.prompt, preset: job.preset });

    return payload;
  } catch (e) {
    if (controller.signal.aborted) return { ok: false, cancelled: true };
    return { ok: false, error: describe(e) };
  } finally {
    running = null;
  }
});

ipcMain.handle(C.CANCEL, () => {
  if (running) running.controller.abort(new Error('cancelled'));
  return true;
});

/**
 * Turns an exception into something a person can act on. The raw messages from
 * these APIs are frequently just "HTTP 401", which tells you nothing about
 * which of three keys is wrong.
 */
function describe(e) {
  const msg = String(e?.message || e);
  if (/HTTP 401|HTTP 403/.test(msg)) return `${msg}\nThat key was rejected — check it in Settings.`;
  if (/HTTP 402/.test(msg)) return `${msg}\nThe account is out of credit.`;
  if (/HTTP 422/.test(msg)) return `${msg}\nThe model rejected an input — run "npm run check-models" to see if its schema changed.`;
  if (/HTTP 429/.test(msg)) return `${msg}\nRate limited — wait a moment and try again.`;
  if (/ECONNREFUSED|fetch failed/i.test(msg)) return `${msg}\nCould not reach the backend. If this is local ComfyUI, is it running?`;
  if (/timed out/i.test(msg)) return `${msg}\nThe backend did not answer in time.`;
  return msg;
}

// --- IPC: game assets ------------------------------------------------------

const LABELS = { pixelate: 'Pixelated', cutout: 'Cut out', sheet: 'Spritesheet' };

ipcMain.handle(C.ASSET_OP, async (_e, { op, source, sources, options }) => {
  try {
    const res = await assetops.run(op, { source, sources, options }, assetsDir());
    // Tool outputs join the history strip so they can be picked up again later.
    store.addHistory({ prompt: LABELS[op] || op, provider: 'tools', model: op, paths: [res.path], inputPath: source?.path || null, meta: {} });
    return res;
  } catch (e) {
    return { ok: false, error: describe(e) };
  }
});

ipcMain.handle(C.PICK_GODOT, async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose your Godot project folder (the one with project.godot)',
    properties: ['openDirectory'],
    defaultPath: store.settings().godotProject || undefined,
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
  const dir = res.filePaths[0];
  if (!assetops.isGodotProject(dir)) return { ok: false, error: 'No project.godot in that folder.' };
  store.setSettings({ godotProject: dir });
  return { ok: true, project: dir };
});

ipcMain.handle(C.EXPORT_GODOT, (_e, { sources, subdir }) => {
  try {
    const s = store.settings();
    if (!s.godotProject) throw new Error('Choose a Godot project first.');
    const files = sources.map((src) => assetops.materialize(src, assetsDir()));
    if (subdir && subdir !== s.godotSubdir) store.setSettings({ godotSubdir: subdir });
    return { ok: true, paths: assetops.exportToGodot(files, s.godotProject, subdir || s.godotSubdir) };
  } catch (e) {
    return { ok: false, error: describe(e) };
  }
});

ipcMain.handle(C.UPDATE_CHECK, () => (updates ? updates.check() : null));
ipcMain.handle(C.UPDATE_INSTALL, () => { updates?.install(); return true; });

// --- IPC: history and files ------------------------------------------------

ipcMain.handle(C.GET_HISTORY, (_e, limit) => store.getHistory(limit));
ipcMain.handle(C.DELETE_HISTORY, (_e, id) => store.deleteHistory(id));
ipcMain.handle(C.CLEAR_HISTORY, () => store.clearHistory());

ipcMain.handle(C.SAVE_AS, async (_e, { dataUri, suggestedName, file }) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save image',
    defaultPath: path.join(app.getPath('pictures'), suggestedName || 'render.png'),
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (res.canceled || !res.filePath) return null;
  // Path-only items (opened from history or disk) have no pixels in the renderer.
  const bytes = dataUri ? Buffer.from(String(dataUri).split(',')[1] || '', 'base64') : fs.readFileSync(file);
  fs.writeFileSync(res.filePath, bytes);
  return res.filePath;
});

/**
 * Writes every image of a multi-output run into one chosen folder.
 *
 * A Save-As dialog per image would be tedious, and saving only the first is how
 * the second image of a two-image run became unreachable in the first place.
 */
ipcMain.handle(C.SAVE_ALL, async (_e, { images: dataUris, stem }) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a folder for all images',
    defaultPath: app.getPath('pictures'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;

  const dir = res.filePaths[0];
  const base = images.slug(stem || 'render');
  const written = [];

  dataUris.forEach((dataUri, i) => {
    const b64 = String(dataUri).split(',')[1] || '';
    let file = path.join(dir, `${base}-${i + 1}.png`);
    let n = 2;
    while (fs.existsSync(file)) file = path.join(dir, `${base}-${i + 1}-${n++}.png`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    written.push(file);
  });

  return written;
});

/**
 * Opens a saved image's folder, or the renders folder when given nothing.
 *
 * shell.openPath resolves to an error STRING rather than rejecting, so the
 * original version - which ignored the promise entirely - failed silently and
 * looked like a dead button. It also has to create the folder first: before the
 * first auto-saved render it does not exist yet, and opening a missing path
 * does nothing at all.
 */
ipcMain.handle(C.REVEAL, async (_e, file) => {
  try {
    if (file && fs.existsSync(file)) {
      shell.showItemInFolder(file);
      return { ok: true };
    }

    const dir = rendersDir();
    fs.mkdirSync(dir, { recursive: true });

    // Prefer showItemInFolder on a real file: openPath hands the folder to the
    // shell and the new window often ends up BEHIND this one, which reads as
    // "the button did nothing". showItemInFolder opens Explorer with the file
    // selected and foregrounds far more reliably.
    const entries = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
    if (entries.length) {
      shell.showItemInFolder(path.join(dir, entries[entries.length - 1]));
      return { ok: true, dir };
    }

    const err = await shell.openPath(dir);
    if (err) return { ok: false, dir, error: err };
    return { ok: true, dir, empty: true };
  } catch (e) {
    return { ok: false, error: describe(e) };
  }
});

ipcMain.handle(C.OPEN_EXTERNAL, (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
  return true;
});

// --- updates -----------------------------------------------------------------

function startUpdater() {
  let autoUpdater = null;
  if (app.isPackaged) {
    try { ({ autoUpdater } = require('electron-updater')); } catch { /* dev tree without the dep */ }
  }
  updates = updater.init({
    autoUpdater: autoUpdater || new (require('events'))(),
    packaged: Boolean(autoUpdater),
    version: app.getVersion(),
    send: (status) => send(C.UPDATE_STATUS, status),
    isBusy: () => Boolean(running),
  });
  // Renderer may not be loaded yet; the banner also polls state() on load.
  updates.check();
}

// --- lifecycle -------------------------------------------------------------

// A second launch should focus the existing window, not start a rival copy that
// writes the same settings file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    const dir = app.getPath('userData');
    store.init(dir);
    secrets.init(dir, safeStorage);
    images.init(nativeImage);
    migrateRenders();
    createWindow();
    startUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
