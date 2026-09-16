'use strict';
/**
 * The entire surface the renderer is allowed to touch.
 *
 * This file is the security boundary. contextIsolation keeps the renderer's
 * JavaScript in a separate world, and only what is listed here crosses over.
 * Never expose `ipcRenderer` itself, and never expose a function that takes a
 * channel name from the caller - either one hands web content the ability to
 * invoke any handler in main, which defeats the whole arrangement.
 *
 * Keep it to thin pass-throughs. Logic belongs in main (testable) or in the
 * renderer (visible); a preload that does real work is hard to reach from
 * either side.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const C = require('../shared/channels');

contextBridge.exposeInMainWorld('app', {
  getState: () => ipcRenderer.invoke(C.GET_STATE),
  setSettings: (patch) => ipcRenderer.invoke(C.SET_SETTINGS, patch),
  resetSettings: () => ipcRenderer.invoke(C.RESET_SETTINGS),

  doWork: () => ipcRenderer.invoke(C.DO_WORK),

  // Subscriptions take a callback and unwrap the IpcRendererEvent, so the
  // renderer never sees an Electron object.
  onProgress: (fn) => ipcRenderer.on(C.PROGRESS, (_e, d) => fn(d)),
});

/**
 * Electron removed the `path` property from dropped File objects (it leaked the
 * filesystem into web content). webUtils.getPathForFile is the supported
 * replacement and only works from preload - hence this separate bridge.
 *
 * Delete it if the app never accepts dropped files.
 */
contextBridge.exposeInMainWorld('filePath', (file) => {
  try {
    return webUtils.getPathForFile(file);
  } catch {
    return '';
  }
});
