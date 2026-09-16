# Beeld

Image generation and editing for Windows, with a swappable backend.

Drop an image in, describe what you want, and run it through whichever engine
you feel like paying for — a free-credit API, a pay-as-you-go one, or ComfyUI on
your own GPU. The same prompt and the same workflow run on all three.

Built as a sibling to [Vloei](../Vloei): a thin local UI over a heavy engine,
except here the engine is behind an HTTP call rather than bundled in.

---

## Why three backends

The honest answer is that none of them is right for everything.

| Backend | Cost to start | Structure control | Good for |
|---|---|---|---|
| **OpenRouter** | Free credits, no card | No | Finding out whether the quality is what you imagined |
| **Replicate** | Pay-as-you-go, no minimum | **Yes** — depth and canny | The real work, including the SketchUp workflow |
| **Local ComfyUI** | Free after setup | Anything you can wire up | Unlimited experimentation, nothing leaves the machine |

They sit behind one interface (`src/main/providers/`), so switching is a
dropdown rather than a rewrite. Everything the app depends on — FLUX, SDXL,
Qwen — is open-weight, which means a workflow proven on a paid API can later run
on your own GPU unchanged. That portability is deliberate: the thing that would
actually lock you in is a *closed* model, not a provider.

---

## Getting started

```bash
npm install
npm start
```

Then open **Settings** and give at least one backend a key.

### OpenRouter — the zero-commitment option

New accounts get free credits, and `:free` models work with a zero balance and
no card at all. Get a key at <https://openrouter.ai/settings/keys>.

It exposes prompt-and-reference generation only — no depth or canny
conditioning — so use it to taste-test quality, not for the CAD workflow.

#### Prompt help is always free, whatever renders the image

The **✦ Improve** button ignores the backend picker entirely. Choose Replicate
or local ComfyUI to render, and Improve still goes to OpenRouter's free tier —
there is no reason to pay a rendering provider for a paragraph of text.

That is enforced, not just intended: a model id that is not `:free` (or the free
router) is refused and the call falls back to the free default, so prompt help
cannot quietly start billing because a paid id reached that setting.

It does still need an OpenRouter key even on other backends — free means
unpriced, not unauthenticated — and the button says so up front rather than
failing on the first click.

#### There is no free rendering anywhere

Worth being blunt about, because it is easy to assume otherwise: **Replicate's
playground is not free**. A playground run is an API call with a web form in
front of it and bills your account identically. Nothing in this app renders an
image for free except local ComfyUI, where you have already paid in electricity
and setup.

What makes Replicate cheap is pay-as-you-go with no minimum — testing costs
cents, not nothing.

#### What the free tier can and cannot do

There are **no free image models**. Checked against the live catalogue: zero of
the 54 image-capable models are `:free`, and `openrouter/free` (the Free Models
Router) declares `input: [text, image]` but `output: [text]`. Every free model
on OpenRouter outputs text.

What they *can* do for nothing is read an image and write about it — so Beeld
spends them on the **✦ Improve** button next to the prompt box. It rewrites a
terse idea into the descriptive language FLUX-class models actually follow, and
when the chosen model has vision it looks at your SketchUp export first and
describes the real building rather than guessing.

21 free models qualify, 11 of them vision-capable; pick one under
**Settings → Prompt help runs on**. Free means unpriced, not unauthenticated —
it still needs an OpenRouter key. Rate limits are roughly 20 requests a minute,
which is ample for a button you press by hand.

### Replicate — pay-as-you-go

No prepaid balance, no minimum, billed in arrears. A key is at
<https://replicate.com/account/api-tokens>. Most runs here cost about 2.5 cents.

### Local ComfyUI

Needs ComfyUI running. On an RX 6800XT that means the
[ZLUDA fork](https://github.com/patientx/ComfyUI-Zluda) — AMD's official
ROCm-on-Windows support covers RDNA3/RDNA4 only, and the 6800XT is RDNA2.

Beeld does not generate workflows. Build one in ComfyUI, export it with
**Workflow → Export (API)**, and point Settings at the file. These tokens are
substituted anywhere they appear in it:

| Token | Becomes |
|---|---|
| `%PROMPT%` | The composed prompt (your text plus the style preset) |
| `%IMAGE%` | Filename of the uploaded input, for a `LoadImage` node |
| `%SEED%` | A fresh random seed each run |

Keeping the workflow as a file you tuned by hand means the app runs exactly what
you tested in the node editor.

---

## The SketchUp workflow

What this was originally built for.

1. In SketchUp, set the camera, hide dimensions and annotations, and export the
   viewport as PNG at 1920×1080 or better.
2. In Beeld: **Replicate → FLUX Depth**, drop the export in as the input image.
3. Describe materials, light and surroundings — not geometry. The model already
   has the geometry from your model; the prompt supplies everything else.
4. Pick a style preset (**Architecture — daylight** is the safe default).

**FLUX.2 Pro** is the other route worth knowing: instead of locking geometry it
takes your model as one of up to eight reference images and rebuilds the scene
around it. Looser about proportions, much stronger on weather, night lighting,
people and cars. Reach for Depth when the building must stay exact, FLUX.2 Pro
when you want the photograph.

Then iterate with **FLUX Kontext**, which edits one thing at a time: feed it a
render you like and say "make the cladding charred timber, overcast light".

A caveat worth keeping in mind: depth conditioning preserves geometry
*approximately*. It is superb for concept and mood, but it is not a renderer and
the output is not dimensionally trustworthy.

---

## Layout

```
src/
  shared/
    models.js       Model catalogue - the ONE place ids and field names live
    presets.js      Prompt presets
    channels.js     IPC vocabulary
  main/
    main.js         Window, IPC, the single generation pipeline
    store.js        Settings + history, atomic writes
    secrets.js      API keys via safeStorage (DPAPI on Windows)
    images.js       Input downscaling, output saving
    http.js         fetch with timeouts and readable errors
    providers/      openrouter.js, replicate.js, comfy.js — one interface each
  renderer/panel/   Plain DOM, no framework
tools/
  check-models.js   Diffs the catalogue against live Replicate schemas
  make-icons.js     Generates src/assets/*.png
```

### Keeping the catalogue honest

`src/shared/models.js` hardcodes each model's input field names, because the
schema endpoint needs a token and the picker has to work before you have one.
The failure mode when a field drifts upstream is a 422 with no clue which field
was wrong, so there is a check for it:

```bash
REPLICATE_API_TOKEN=r8_... npm run check-models
```

It fetches every live schema and reports any field the catalogue names that no
longer exists.

## Where renders go

`<Pictures>/Beeld`, overridable in Settings. Deliberately **not** `userData`:

Generated images are your documents, not app state — but there is a sharper
reason. `%APPDATA%` can be *virtualized*. Launched as a child of a packaged
(MSIX) app, this process sees `%APPDATA%\Beeld` transparently redirected into
that package's `LocalCache`. Beeld reads and writes there fine and
`fs.existsSync` says the folder is present, but **Explorer runs outside the
container** — so "Open folder" produced *"Location is not available"* for a path
that demonstrably existed. Known folders such as Pictures are not redirected.

Renders made before this change are moved on next launch, and their history
entries are rewritten to match.

Config and API keys still live in `userData`, which is the right place for them.

## Tests

```bash
npm test
```

No network. They cover the things that are cheap to get wrong and expensive to
discover live — which field an image goes in, whether a model returns one URI or
a list, whether a stale slider can leak into a request, and that a corrupt
settings file falls back to defaults instead of bricking the app.
