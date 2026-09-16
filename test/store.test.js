'use strict';
/**
 * Settings and history persistence.
 *
 * Driven against a temp directory rather than Electron's userData, which is why
 * store.init() takes the path instead of reading it from `app`.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/main/store');

let passed = 0;
function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeld-test-'));
  try {
    store.init(dir);
    fn(dir);
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('settings');

test('defaults apply on a fresh profile', () => {
  assert.strictEqual(store.settings().provider, 'openrouter');
  assert.strictEqual(store.settings().outputFormat, 'png');
});

test('a patch persists and survives a reload', (dir) => {
  store.setSettings({ provider: 'replicate', lastPrompt: 'a barn' });
  store.init(dir);
  assert.strictEqual(store.settings().provider, 'replicate');
  assert.strictEqual(store.settings().lastPrompt, 'a barn');
});

test('an unknown key added later still gets its default', (dir) => {
  // Simulates upgrading the app: an old settings file must not shadow a new
  // default with undefined.
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ provider: 'replicate' }));
  store.init(dir);
  assert.strictEqual(store.settings().provider, 'replicate');
  assert.strictEqual(store.settings().maxInputEdge, 1536);
});

test('a corrupt settings file falls back to defaults instead of crashing', (dir) => {
  fs.writeFileSync(path.join(dir, 'settings.json'), '{not json');
  store.init(dir);
  assert.strictEqual(store.settings().provider, 'openrouter');
});

test('out-of-range values are clamped', () => {
  store.setSettings({ historyMax: 999999, numOutputs: 99, maxInputEdge: 1, confirmOverSpend: -5 });
  const s = store.settings();
  assert.strictEqual(s.historyMax, 5000);
  assert.strictEqual(s.numOutputs, 4);
  assert.strictEqual(s.maxInputEdge, 256);
  assert.strictEqual(s.confirmOverSpend, 0);
});

test('reset restores defaults', () => {
  store.setSettings({ provider: 'comfy' });
  store.resetSettings();
  assert.strictEqual(store.settings().provider, 'openrouter');
});

test('writes are atomic - no .tmp left behind', (dir) => {
  store.setSettings({ lastPrompt: 'x' });
  assert.ok(!fs.existsSync(path.join(dir, 'settings.json.tmp')));
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
});

console.log('history');

test('entries come back newest first', () => {
  store.addHistory({ prompt: 'first' });
  store.addHistory({ prompt: 'second' });
  const h = store.getHistory();
  assert.strictEqual(h.length, 2);
  assert.strictEqual(h[0].prompt, 'second');
});

test('every entry gets an id and a timestamp', () => {
  const rec = store.addHistory({ prompt: 'x' });
  assert.ok(rec.id);
  assert.ok(!Number.isNaN(Date.parse(rec.at)));
});

test('history is capped at historyMax', () => {
  store.setSettings({ historyMax: 3 });
  for (let i = 0; i < 10; i++) store.addHistory({ prompt: `p${i}` });
  const h = store.getHistory();
  assert.strictEqual(h.length, 3);
  assert.strictEqual(h[0].prompt, 'p9');
});

test('disabling history stops recording', () => {
  store.setSettings({ historyEnabled: false });
  assert.strictEqual(store.addHistory({ prompt: 'x' }), null);
  assert.strictEqual(store.getHistory().length, 0);
});

test('delete removes one entry, clear removes all', () => {
  const a = store.addHistory({ prompt: 'a' });
  store.addHistory({ prompt: 'b' });
  store.deleteHistory(a.id);
  assert.strictEqual(store.getHistory().length, 1);
  store.clearHistory();
  assert.strictEqual(store.getHistory().length, 0);
});

test('history survives a reload', (dir) => {
  store.addHistory({ prompt: 'persisted' });
  store.init(dir);
  assert.strictEqual(store.getHistory()[0].prompt, 'persisted');
});

console.log(`\n${passed} passed`);
