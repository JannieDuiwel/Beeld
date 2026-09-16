'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const C = require('../shared/channels');

// Electron removed the `path` property from dropped File objects (it leaked the
// filesystem into web content). webUtils.getPathForFile is the supported
// replacement, and it only works from preload - hence this separate bridge.
contextBridge.exposeInMainWorld('beeldPath', (file) => {
  try {
    return webUtils.getPathForFile(file);
  } catch {
    return '';
  }
});

contextBridge.exposeInMainWorld('beeld', {
  getState: () => ipcRenderer.invoke(C.GET_STATE),
  setSettings: (patch) => ipcRenderer.invoke(C.SET_SETTINGS, patch),
  resetSettings: () => ipcRenderer.invoke(C.RESET_SETTINGS),

  setKey: (provider, key) => ipcRenderer.invoke(C.SET_KEY, { provider, key }),
  clearKey: (provider) => ipcRenderer.invoke(C.CLEAR_KEY, provider),
  testKey: (provider) => ipcRenderer.invoke(C.TEST_KEY, provider),

  pickImage: () => ipcRenderer.invoke(C.PICK_IMAGE),
  loadImage: (file) => ipcRenderer.invoke(C.LOAD_IMAGE, file),
  listModels: (provider) => ipcRenderer.invoke(C.LIST_MODELS, provider),
  listFreeModels: () => ipcRenderer.invoke(C.LIST_FREE_MODELS),
  enhancePrompt: (prompt, imagePath) => ipcRenderer.invoke(C.ENHANCE_PROMPT, { prompt, imagePath }),

  generate: (job) => ipcRenderer.invoke(C.GENERATE, job),
  cancel: () => ipcRenderer.invoke(C.CANCEL),

  getHistory: (limit) => ipcRenderer.invoke(C.GET_HISTORY, limit),
  deleteHistory: (id) => ipcRenderer.invoke(C.DELETE_HISTORY, id),
  clearHistory: () => ipcRenderer.invoke(C.CLEAR_HISTORY),

  saveAs: (dataUri, suggestedName) => ipcRenderer.invoke(C.SAVE_AS, { dataUri, suggestedName }),
  saveAll: (images, stem) => ipcRenderer.invoke(C.SAVE_ALL, { images, stem }),
  reveal: (file) => ipcRenderer.invoke(C.REVEAL, file),
  openExternal: (url) => ipcRenderer.invoke(C.OPEN_EXTERNAL, url),

  onStage: (fn) => ipcRenderer.on(C.STAGE, (_e, d) => fn(d)),
  onError: (fn) => ipcRenderer.on(C.ERROR, (_e, d) => fn(d)),
});
