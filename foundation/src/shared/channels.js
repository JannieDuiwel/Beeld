'use strict';
/**
 * One place where the IPC vocabulary lives, so main, preload and the renderer
 * cannot drift apart. Required from main and from preload (preload runs with
 * Node access); the renderer receives the surface via contextBridge.
 *
 * Why a shared constants file rather than string literals at each call site:
 * a typo in a channel name fails silently - the sender succeeds, no handler
 * runs, and nothing is logged. Naming them once turns that into a reference
 * error you get on the first run.
 */

module.exports = {
  // renderer -> main (invoke, returns a value)
  GET_STATE: 'panel:get-state',
  SET_SETTINGS: 'panel:set-settings',
  RESET_SETTINGS: 'panel:reset-settings',
  DO_WORK: 'panel:do-work',

  // main -> renderer (send, fire and forget)
  PROGRESS: 'panel:progress',
};
