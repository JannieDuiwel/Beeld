# Foundation

A runnable skeleton for a local-first Windows Electron app, extracted from
[Vloei](../../Vloei) and [Beeld](..). See [FOUNDATION.md](../FOUNDATION.md) for
the conventions and the reasoning behind them.

It is a working app, not a pile of templates — clone, run, and you get a window
with a setting that persists and an async job reporting progress back. Every
seam you will actually use is already wired: IPC both directions, contextBridge,
atomic settings, icon generation, packaging, tests.

## Use it

```bash
cp -r foundation ../MyApp
cd ../MyApp
npm install
npm start
```

Then:

1. **`package.json`** — `name` (lowercase, becomes the userData folder),
   `productName`, `description`, `version`.
2. **`electron-builder.yml`** — `appId`, `productName`, `shortcutName`.
3. **`tools/make-icons.js`** — replace `icon()`. It is called per pixel and
   returns `[r, g, b]`.
4. **`src/shared/channels.js`** — replace the example channels with yours.
5. **`src/main/store.js`** — replace `DEFAULTS` with your settings.
6. **`src/renderer/panel/`** — replace the panel with your UI.
7. **`src/preload/panel.js`** — rename the exposed world from `app` to
   something app-specific, and drop the `filePath` bridge if you never accept
   dropped files.

Delete `DO_WORK` and its handler once you have a real job to run — it exists to
show the shape, not because you need it.

## Commands

| | |
|---|---|
| `npm start` | Run it |
| `npm run dev` | Run with DevTools, and renderer errors forwarded to the terminal |
| `npm test` | Node's own `assert`, no dependencies, sub-second |
| `npm run icons` | Regenerate `src/assets/*.png` (also runs on `postinstall`) |
| `npm run build` | NSIS installer into `dist/` |

`npm test` works on a fresh clone *before* `npm install`, because nothing it
touches requires Electron.

## What you get

```
src/
  main/       main.js (window, lifecycle, IPC), store.js (atomic settings)
  preload/    panel.js — the entire surface the renderer may touch
  renderer/   panel/ — plain HTML + JS, no framework, no build step
  shared/     channels.js — the IPC vocabulary, required by main and preload
  assets/     generated PNGs (git-ignored)
tools/        make-icons.js
test/         store.test.js
```

## Deliberate omissions

No logger, no auto-updater, no crash reporting, no state-management library, no
CSS framework. Each is a real dependency with real upkeep, and none of them is
needed by an app that does not exist yet. Add them when something hurts.
