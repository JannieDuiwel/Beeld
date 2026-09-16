'use strict';
/**
 * Settings persistence.
 *
 * The harness is deliberately tiny: node's own `assert`, a `test()` that counts
 * failures and sets process.exitCode, and no dependencies. `npm test` therefore
 * works on a fresh clone before `npm install` has fetched Electron, and runs in
 * well under a second.
 *
 * Every case gets its own temp directory, which is the whole reason Store takes
 * its directory as a constructor argument instead of being a module singleton -
 * no global state to reset, no ordering dependencies between cases.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store, DEFAULTS } = require('../src/main/store');

let passed = 0;
function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-test-'));
  try {
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

test('defaults apply on a fresh profile', (dir) => {
  assert.strictEqual(new Store(dir).get().theme, DEFAULTS.theme);
});

test('a patch persists and survives a reload', (dir) => {
  new Store(dir).update({ note: 'hello' });
  assert.strictEqual(new Store(dir).get().note, 'hello');
});

test('update returns the new settings, so callers need no second read', (dir) => {
  assert.strictEqual(new Store(dir).update({ note: 'x' }).note, 'x');
});

test('a key added in a later version still gets its default', (dir) => {
  // Simulates upgrading the app: an old settings file must not shadow a new
  // default with undefined.
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ note: 'old' }));
  const s = new Store(dir).get();
  assert.strictEqual(s.note, 'old');
  assert.strictEqual(s.windowWidth, DEFAULTS.windowWidth);
});

test('a corrupt settings file falls back to defaults instead of crashing', (dir) => {
  fs.writeFileSync(path.join(dir, 'settings.json'), '{not json');
  assert.strictEqual(new Store(dir).get().theme, DEFAULTS.theme);
});

test('out-of-range values are clamped', (dir) => {
  const s = new Store(dir).update({ windowWidth: 999999, windowHeight: 1 });
  assert.strictEqual(s.windowWidth, 7680);
  assert.strictEqual(s.windowHeight, 360);
});

test('a non-numeric value falls back to the default rather than NaN', (dir) => {
  assert.strictEqual(new Store(dir).update({ windowWidth: 'wide' }).windowWidth, DEFAULTS.windowWidth);
});

test('reset restores defaults', (dir) => {
  const st = new Store(dir);
  st.update({ note: 'x', runCount: 9 });
  const s = st.reset();
  assert.strictEqual(s.note, DEFAULTS.note);
  assert.strictEqual(s.runCount, DEFAULTS.runCount);
});

test('writes are atomic - no .tmp left behind', (dir) => {
  new Store(dir).update({ note: 'x' });
  assert.ok(!fs.existsSync(path.join(dir, 'settings.json.tmp')));
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
});

test('two stores in one process do not share state', (dir) => {
  // The property that makes the class form worth preferring over a singleton.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-test-b-'));
  try {
    new Store(dir).update({ note: 'first' });
    new Store(other).update({ note: 'second' });
    assert.strictEqual(new Store(dir).get().note, 'first');
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed`);
