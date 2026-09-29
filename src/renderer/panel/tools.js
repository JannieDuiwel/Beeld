'use strict';
/**
 * Game tools bar and update banner. Loaded after panel.js and shares its
 * top-level state (state, result, selected, showResult, showBusy, showError).
 *
 * Every tool acts on "the image on screen" and shows its output as the new
 * image, so tools chain: generate -> cut out -> pixelate -> export.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const tray = [];           // [{ path, dataUri }] frames for a spritesheet

  const shown = () => result?.images?.[selected] || null;
  const note = (msg, cls) => { const n = $('toolNote'); n.textContent = msg || ''; n.style.color = cls === 'bad' ? 'var(--bad)' : cls === 'good' ? 'var(--good)' : 'var(--faint)'; };

  // --- tabs ----------------------------------------------------------------
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
    document.querySelectorAll('.tabbody').forEach((b) => { b.hidden = b.dataset.body !== t.dataset.tab; });
    note('');
  }));

  // --- running an op -------------------------------------------------------
  async function run(op, payload, label) {
    if (busy) return null;
    note(`${label}…`);
    const res = await api.assetOp(op, payload);
    if (!res.ok) { note(res.error || 'That did not work.', 'bad'); return null; }
    showResult({ prompt: label, images: [{ dataUri: res.dataUri, path: res.path }], meta: {} });
    note(`${res.info} — saved to ${res.path}`, 'good');
    return res;
  }

  function needImage() {
    if (shown()) return true;
    note('Generate or load an image first — tools act on the image on screen.', 'bad');
    return false;
  }

  $('runPixel').addEventListener('click', () => {
    if (!needImage()) return;
    run('pixelate', {
      source: shown(),
      options: {
        width: Number($('pxWidth').value), colors: Number($('pxColors').value),
        scale: Number($('pxScale').value), dither: $('pxDither').checked,
      },
    }, 'Pixelating');
  });

  $('runCut').addEventListener('click', () => {
    if (!needImage()) return;
    run('cutout', { source: shown(), options: { tolerance: Number($('cutTol').value), trim: $('cutTrim').checked } }, 'Removing background');
  });

  // --- spritesheet tray ----------------------------------------------------
  function renderTray() {
    const box = $('tray');
    box.innerHTML = '';
    tray.forEach((f, i) => {
      const img = document.createElement('img');
      img.src = f.dataUri;
      img.title = 'Click to remove';
      img.addEventListener('click', () => { tray.splice(i, 1); renderTray(); });
      box.appendChild(img);
    });
    $('trayCount').textContent = tray.length ? `(${tray.length})` : '';
  }

  $('trayAdd').addEventListener('click', () => {
    if (!needImage()) return;
    const s = shown();
    tray.push({ path: s.path, dataUri: s.dataUri });
    renderTray();
  });
  $('trayClear').addEventListener('click', () => { tray.length = 0; renderTray(); });

  $('runSheet').addEventListener('click', () => {
    const m = /^\s*(\d+)\s*[x×,]\s*(\d+)\s*$/i.exec($('sheetCell').value);
    run('sheet', {
      sources: tray,
      options: { cols: Number($('sheetCols').value) || 0, cellW: m ? m[1] : 0, cellH: m ? m[2] : 0 },
    }, 'Building sheet');
  });

  // --- Godot ---------------------------------------------------------------
  function renderGodot() {
    $('godotPath').value = state?.godotProject || '';
    $('godotSub').value = state?.godotSubdir || 'assets';
  }

  $('godotPick').addEventListener('click', async () => {
    const r = await api.pickGodot();
    if (r.ok) { state = await api.getState(); renderGodot(); note('Godot project set.', 'good'); }
    else if (!r.cancelled) note(r.error, 'bad');
  });

  async function exportGodot(sources) {
    if (!sources.length) { note('Nothing to export.', 'bad'); return; }
    const r = await api.exportGodot(sources, $('godotSub').value.trim() || 'assets');
    if (!r.ok) { note(r.error, 'bad'); return; }
    state.godotSubdir = $('godotSub').value.trim() || 'assets';
    note(`Exported: ${r.paths.join('  ')}`, 'good');
  }
  $('godotExport').addEventListener('click', () => { if (needImage()) exportGodot([shown()]); });
  $('godotExportTray').addEventListener('click', () => exportGodot(tray));

  // --- updates -------------------------------------------------------------
  function renderUpdate(u) {
    if (!u) return;
    const bar = $('updateBar');
    const txt = $('updateText');
    $('updateNow').hidden = u.state !== 'ready';
    bar.hidden = !['downloading', 'ready', 'restarting'].includes(u.state);
    txt.textContent =
      u.state === 'downloading' ? `Downloading Beeld ${u.next || ''}${u.percent ? ` — ${u.percent}%` : ''}…`
      : u.state === 'restarting' ? `Updated to ${u.next}. Restarting…`
      : u.state === 'ready' ? `Beeld ${u.next} is ready. It installs when you quit, or now:` : '';

    $('versionText').textContent = `Beeld ${u.version}`;
    $('updateHint').textContent =
      u.state === 'dev' ? 'Updates only run in the installed app.'
      : u.state === 'current' ? 'You are on the latest version.'
      : u.state === 'error' ? `Could not check: ${u.message}`
      : u.state === 'checking' ? 'Checking…' : '';
  }
  api.onUpdate(renderUpdate);
  $('updateNow').addEventListener('click', () => api.installUpdate());
  $('checkUpdate').addEventListener('click', async () => renderUpdate(await api.checkUpdate()));

  // panel.js boots asynchronously; the update event can arrive before state does.
  (async function init() {
    for (let i = 0; i < 50 && !state; i++) await new Promise((r) => setTimeout(r, 100));
    renderGodot();
    renderUpdate(state?.update);
  })();
})();
