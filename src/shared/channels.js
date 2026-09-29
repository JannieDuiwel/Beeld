'use strict';
/**
 * One place where the IPC vocabulary lives, so main, preload and the renderer
 * cannot drift apart. Required from main and from preload (preload runs with
 * Node access); the renderer receives the surface via contextBridge.
 */

module.exports = {
  // panel -> main (invoke)
  GET_STATE: 'panel:get-state',
  SET_SETTINGS: 'panel:set-settings',
  RESET_SETTINGS: 'panel:reset-settings',

  SET_KEY: 'panel:set-key',
  CLEAR_KEY: 'panel:clear-key',
  TEST_KEY: 'panel:test-key',

  PICK_IMAGE: 'panel:pick-image',
  LOAD_IMAGE: 'panel:load-image',
  LIST_MODELS: 'panel:list-models',
  LIST_FREE_MODELS: 'panel:list-free-models',
  ENHANCE_PROMPT: 'panel:enhance-prompt',

  GENERATE: 'panel:generate',
  CANCEL: 'panel:cancel',

  GET_HISTORY: 'panel:get-history',
  DELETE_HISTORY: 'panel:delete-history',
  CLEAR_HISTORY: 'panel:clear-history',

  SAVE_AS: 'panel:save-as',
  SAVE_ALL: 'panel:save-all',
  REVEAL: 'panel:reveal',
  OPEN_EXTERNAL: 'panel:open-external',

  ASSET_OP: 'panel:asset-op',
  PICK_GODOT: 'panel:pick-godot',
  EXPORT_GODOT: 'panel:export-godot',

  UPDATE_CHECK: 'panel:update-check',
  UPDATE_INSTALL: 'panel:update-install',

  // main -> panel (send)
  UPDATE_STATUS: 'panel:update-status',
  STAGE: 'panel:stage',        // progress text for the current run
  RESULT: 'panel:result',      // a finished generation
  ERROR: 'panel:error',
};
