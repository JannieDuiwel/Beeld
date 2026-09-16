# Foundation

The shared architecture behind [Vloei](../Vloei) and [Beeld](.), extracted so
the third app does not have to rediscover it.

[`foundation/`](foundation) is a runnable skeleton of everything below. This
document is the reasoning; that directory is the code.

Both apps are the same shape — a thin local UI over a heavy engine — and they
arrived there independently. Vloei's engine is bundled (ONNX Whisper running
in-process); Beeld's is behind an HTTP call. That difference turns out to change
almost nothing about the structure, which is why it is worth writing down.

---

## The layout

```
src/
  main/       Node. Window, lifecycle, IPC, and the app's own logic.
  preload/    The entire surface the renderer may touch. The security boundary.
  renderer/   <window>/index.html + <window>.js — plain DOM, no build step.
  shared/     channels.js — the IPC vocabulary, required by main AND preload.
  assets/     Generated PNGs. Git-ignored, rebuilt on postinstall.
tools/        Build-time scripts. Excluded from the packaged app.
test/         Plain node + assert. No runner, no dependencies.
```

One directory per window under `renderer/`. Vloei has three (`overlay`,
`panel`, `engine`); Beeld has one. The naming stays the same either way, so
`src/preload/panel.js` always pairs with `src/renderer/panel/`.

---

## The rules

### Main holds the logic, and must be testable without Electron

Everything `main.js` calls should be plain Node that a test can drive directly.
That one constraint is why both apps have a fast, dependency-free suite: the
store, the providers, the prompt handling and the request shaping are all
importable without booting a browser.

`main.js` itself is the only file that gets to know about both Electron and the
app's own modules.

### `shared/channels.js` is the single IPC vocabulary

A typo'd channel name fails *silently* — the sender succeeds, no handler runs,
nothing is logged. Naming every channel once turns that into a reference error
on the first run.

### Preload exposes functions, never `ipcRenderer`

```js
contextBridge.exposeInMainWorld('app', {
  getState: () => ipcRenderer.invoke(C.GET_STATE),
});
```

Never expose `ipcRenderer` itself, and never expose a function that takes a
channel name *from the caller* — either hands web content the ability to invoke
any handler in main, which defeats the arrangement.

Baseline, non-negotiable:

```js
contextIsolation: true,
nodeIntegration: false,
sandbox: false,     // so preload may require() — it is code we wrote
```

### IPC handlers return results, they do not throw

An exception crossing the boundary reaches the renderer as an opaque
`Error invoking remote method`. Catch it in the handler and return
`{ ok: false, error }` — then the UI can say something useful.

### Settings are written atomically

Temp file, then rename. A crash mid-write must not leave truncated JSON that
bricks the app on next launch. Both apps hand-roll this rather than take
`electron-store`; it is about fifteen lines.

A corrupt settings file falls back to defaults rather than refusing to start,
and defaults are merged *under* the loaded file so a key added in a later
version still gets a value.

### Secrets do not go in settings.json

That file is plain text someone might paste into a bug report, and on this
machine it sits under OneDrive. Keys go through `safeStorage` (DPAPI on
Windows) in a separate file. When `safeStorage` is unavailable, keep them in
memory for the session and *say so* — never silently write a plaintext key.

### The renderer is plain DOM

No framework, no bundler, no build step. `git clone && npm start` runs, with
nothing to compile and nothing to keep current.

This is a judgement, not dogma: reach for a framework when there is genuine
component reuse or derived state that hurts to sync by hand. A settings panel is
neither. Both apps stayed under ~700 renderer lines.

### Prefer hand-rolling to a dependency

Vloei ships one runtime dependency (`koffi`, for Win32 calls). Beeld ships zero.
Icon generation, PNG encoding, atomic writes, the HTTP wrapper and the test
harness are all a few dozen lines each, and each avoided dependency is one less
thing to rebuild per Electron version.

The bar: if it is under ~50 lines and you understand it, write it.

### Comments say *why*

The code says what it does. Comments are for the reason it is that way — the
constraint, the bug that forced it, the option rejected. A comment restating the
line below it is noise; a comment explaining why a poll runs at 125 Hz, or why a
field is an array for one model and a string for another, is the thing you came
back for.

### Assets are generated, not committed

`tools/make-icons.js` writes the PNGs from code on `postinstall`. The repo
carries no binary blobs, and the artwork is tweaked by editing numbers.

---

## Where the two apps disagreed

Worth naming, because the skeleton had to pick one and the choice is not
arbitrary.

| | Vloei | Beeld | Foundation takes |
|---|---|---|---|
| Store | `class Store(dir)` | module singleton + `init(dir)` | **Vloei's class** |
| Tests | inline `check(got, want)`, stringified compare | `test(name, fn)` + `assert`, sets exit code | **Beeld's harness** |

**The class wins** because it takes its directory as an argument. Several stores
can exist in one test process, so no case can leak into the next and there is no
hidden global to reset. The singleton needed an `init()` call at the top of
every test.

**Beeld's harness wins** because `String(got) === String(want)` passes on
comparisons it should not, and because setting `process.exitCode` is what makes
`npm test` fail a build.

---

## Windows and Electron gotchas

Each of these cost real debugging time.

**`%APPDATA%` can be virtualized.** Launched as a child of a packaged (MSIX)
app, a process sees `%APPDATA%\YourApp` silently redirected into that package's
`LocalCache`. Your app reads and writes it fine and `fs.existsSync` says it is
there — but Explorer runs *outside* the container, so `shell.openPath` on it
fails with "Location is not available" for a path that demonstrably exists.
Put user-facing output in a known folder (`app.getPath('pictures')`), and keep
`userData` for config only.

**`shell.openPath` resolves to an error *string*, it does not reject.** Ignore
the returned promise and failures are invisible. It also tends to open behind
the calling window; `shell.showItemInFolder` on a real file foregrounds more
reliably.

**`File.path` is gone from dropped files.** Use `webUtils.getPathForFile`, which
only works from preload.

**A class rule beats `[hidden]`.** `.row { display: flex }` outranks the UA
stylesheet's `[hidden] { display: none }`, so elements toggled by the attribute
stay visible. Ship `[hidden] { display: none !important }`.

**A throw while wiring listeners kills every listener after it**, which presents
as "that button does nothing" with nothing in the terminal. Forward renderer
console errors to stdout in dev mode.

**`globalShortcut` has no key-up event**, so it cannot do hold-to-talk. Vloei
polls `GetAsyncKeyState` via `koffi` instead.

**Native modules and URL-fetched files cannot live inside the asar.** Add
`asarUnpack` entries for them. Beeld needs none, which is why it packages
cleanly where Vloei needed carve-outs for `koffi` and ONNX.

---

## What is deliberately absent

No logger, auto-updater, crash reporting, state-management library or CSS
framework. Each is real upkeep, and none is needed by an app that does not exist
yet. Add them when something actually hurts.
