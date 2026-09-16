'use strict';
/**
 * Main process: window, lifecycle, and IPC.
 *
 * Keep this the only file that knows about both Electron and the app's own
 * modules. Everything it calls (store.js, and whatever you add beside it)
 * should be plain Node that a test can drive without booting Electron - that
 * single rule is what makes the test suite fast and dependency-free.
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

const C = require('../shared/channels');
const { Store, DEFAULTS } = require('./store');

const DEV = process.argv.includes('--dev');

let win = null;
let store = null;

// --- window ----------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: store.get().windowWidth,
    height: store.get().windowHeight,
    minWidth: 480,
    minHeight: 360,
    // Painted before the renderer loads, so startup is not a white flash.
    backgroundColor: '#12131a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'panel.js'),
      // The security baseline. The renderer gets no Node access; everything it
      // may do is listed explicitly in preload/panel.js. sandbox stays false so
      // preload can use require() - it is trusted code that we wrote.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'panel', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Remember the size, debounced - 'resize' fires per pixel dragged and every
  // one of those would be a disk write.
  let resizeTimer = null;
  win.on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMaximized()) return;
      const [w, h] = win.getSize();
      store.update({ windowWidth: w, windowHeight: h });
    }, 400);
  });

  if (DEV) {
    win.webContents.openDevTools({ mode: 'detach' });

    // A throw while wiring listeners silently kills every listener after it,
    // which presents as "that button does nothing". Forwarding renderer errors
    // to the terminal makes that visible instead of mysterious. The signature
    // changed across Electron versions: older builds pass positional args,
    // newer ones a details object.
    win.webContents.on('console-message', (...args) => {
      const d = typeof args[1] === 'object'
        ? args[1]
        : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
      const level = String(d.level);
      if (level === 'error' || level === 'warning' || Number(d.level) >= 2) {
        console.error(`[renderer] ${d.message} (${d.sourceId || '?'}:${d.lineNumber || 0})`);
      }
    });
  }

  // Never let web content open a real Electron window; hand links to the OS.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// --- IPC -------------------------------------------------------------------
//
// One handler per channel in shared/channels.js. Handlers return plain data and
// never throw across the boundary: an exception in a handler reaches the
// renderer as an opaque "Error invoking remote method", so catch it here and
// return { ok: false, error } instead.

ipcMain.handle(C.GET_STATE, () => ({
  settings: store.get(),
  defaults: DEFAULTS,
}));

ipcMain.handle(C.SET_SETTINGS, (_e, patch) => ({
  settings: store.update(patch),
  defaults: DEFAULTS,
}));

ipcMain.handle(C.RESET_SETTINGS, () => ({
  settings: store.reset(),
  defaults: DEFAULTS,
}));

/**
 * Stand-in for whatever the app actually does. Shows the shape worth copying:
 * report progress as it goes, and return a result object rather than throwing.
 */
ipcMain.handle(C.DO_WORK, async () => {
  try {
    for (let i = 1; i <= 3; i++) {
      send(C.PROGRESS, `Step ${i} of 3…`);
      await new Promise((r) => setTimeout(r, 250));
    }
    const settings = store.update({ runCount: store.get().runCount + 1 });
    return { ok: true, runCount: settings.runCount };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

// --- lifecycle -------------------------------------------------------------

// A second launch should focus the existing window, not start a rival copy that
// writes the same settings file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    // userData is the right home for settings and secrets. It is NOT the right
    // home for files the user should be able to find in Explorer - put those in
    // a known folder such as app.getPath('pictures') or 'documents'.
    store = new Store(app.getPath('userData'));
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
