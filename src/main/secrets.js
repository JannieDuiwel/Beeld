'use strict';
/**
 * API key storage.
 *
 * Kept out of settings.json on purpose: that file is plain JSON a user might
 * paste into a bug report, and it lives under a OneDrive-synced profile. Keys
 * go through Electron's safeStorage, which on Windows wraps DPAPI - the
 * ciphertext is bound to the Windows user account, so copying the file to
 * another machine yields nothing.
 *
 * safeStorage can be unavailable (no keyring on some Linux setups, and it is
 * not ready before app 'ready'). When it is, we degrade to keeping the key in
 * memory for the session only and say so in the UI, rather than silently
 * writing a plaintext key to disk.
 */

const fs = require('fs');
const path = require('path');

let file = null;
let safeStorage = null;
let memory = {};          // session-only fallback, never written to disk
let encryptedOk = false;

function init(dataDir, storage) {
  file = path.join(dataDir, 'keys.dat');
  safeStorage = storage || null;
  fs.mkdirSync(dataDir, { recursive: true });
  encryptedOk = Boolean(safeStorage && safeStorage.isEncryptionAvailable());
  memory = {};
  return module.exports;
}

/** True when keys survive a restart. The UI says so plainly when false. */
function persistent() {
  return encryptedOk;
}

function readAll() {
  if (!encryptedOk) return { ...memory };
  try {
    const buf = fs.readFileSync(file);
    const parsed = JSON.parse(safeStorage.decryptString(buf));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Missing on first run; undecryptable if the Windows profile changed.
    // Either way the only sane result is "no keys yet".
    return {};
  }
}

function writeAll(map) {
  if (!encryptedOk) {
    memory = { ...map };
    return;
  }
  const buf = safeStorage.encryptString(JSON.stringify(map));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

function get(providerId) {
  return readAll()[providerId] || '';
}

function set(providerId, key) {
  const map = readAll();
  const trimmed = String(key || '').trim();
  if (trimmed) map[providerId] = trimmed;
  else delete map[providerId];
  writeAll(map);
  return true;
}

function clear(providerId) {
  return set(providerId, '');
}

/** Which providers currently hold a key, for the UI - never the values. */
function status() {
  const map = readAll();
  return Object.fromEntries(Object.keys(map).map((k) => [k, Boolean(map[k])]));
}

module.exports = { init, persistent, get, set, clear, status };
