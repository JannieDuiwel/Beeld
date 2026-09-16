'use strict';
/**
 * Settings persistence.
 *
 * Hand-rolled rather than pulling in electron-store: it is a few dozen lines,
 * has no dependency surface, and lets us do atomic writes (write temp, rename)
 * so a crash mid-save cannot leave a truncated settings file that bricks the app.
 *
 * A class taking its directory as an argument, NOT a module singleton with an
 * init() call. The difference matters in tests: several independent stores can
 * exist in one process, so a test cannot leak state into the next one, and
 * there is no hidden global to reset between cases.
 *
 * Secrets do NOT belong here. settings.json is plain text a user might paste
 * into a bug report or sync to OneDrive. Put API keys and tokens behind
 * Electron's safeStorage in a separate file.
 */

const fs = require('fs');
const path = require('path');

/**
 * Every setting the app has, with its default.
 *
 * Group these with section comments and say WHY a non-obvious default is what
 * it is. This object is the closest thing to documentation of what the app can
 * be made to do, and it is read far more often than it is written.
 */
const DEFAULTS = {
  // --- interface -----------------------------------------------------------
  theme: 'dark',
  // Remembered so reopening the app feels like returning to it rather than
  // starting over.
  windowWidth: 900,
  windowHeight: 650,

  // --- example state -------------------------------------------------------
  note: '',
  runCount: 0,
};

/** Bounds for values a bad input could otherwise break. */
const LIMITS = {
  windowWidth: [480, 7680],
  windowHeight: [360, 4320],
};

class Store {
  constructor(dir) {
    this.dir = dir;
    this.settingsPath = path.join(dir, 'settings.json');
    fs.mkdirSync(dir, { recursive: true });
    this.settings = { ...DEFAULTS, ...this._read(this.settingsPath) };
  }

  _read(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // Missing is normal on first run. Corrupt is not, but the only useful
      // recovery is to fall back to defaults rather than refuse to start.
      return {};
    }
  }

  /** Write via temp + rename so an interrupted write cannot truncate the file. */
  _writeAtomic(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  get() {
    return this.settings;
  }

  /**
   * Merges a patch over the current settings, clamps what needs clamping, and
   * persists. Returns the new settings so a caller can hand them straight back
   * to the renderer without a second read.
   */
  update(patch) {
    const next = { ...this.settings, ...(patch || {}) };

    for (const [key, [lo, hi]] of Object.entries(LIMITS)) {
      const n = Number(next[key]);
      next[key] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULTS[key];
    }

    this.settings = next;
    this._writeAtomic(this.settingsPath, this.settings);
    return this.settings;
  }

  reset() {
    this.settings = { ...DEFAULTS };
    this._writeAtomic(this.settingsPath, this.settings);
    return this.settings;
  }
}

module.exports = { Store, DEFAULTS, LIMITS };
