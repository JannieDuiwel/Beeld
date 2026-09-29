'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const updater = require('../src/main/updater');

function harness({ busy = false, packaged = true } = {}) {
  const au = new EventEmitter();
  let installed = 0, t = 0;
  au.quitAndInstall = () => { installed++; };
  au.checkForUpdates = () => Promise.resolve();
  const sent = [];
  let timers = [];
  const u = updater.init({ autoUpdater: au, packaged, version: '0.2.0', send: (s) => sent.push(s.state), isBusy: () => busy,
    now: () => t, setTimer: (fn) => timers.push(fn) });
  return { au, u, sent, advance: (ms) => { t += ms; }, fire: () => timers.splice(0).forEach((f) => f()), installed: () => installed };
}

// update found + downloaded right after launch and idle -> restarts itself
let h = harness();
h.au.emit('update-available', { version: '0.3.0' });
h.au.emit('update-downloaded', { version: '0.3.0' });
assert.deepStrictEqual(h.sent.slice(-2), ['downloading', 'restarting']);
h.fire();
assert.strictEqual(h.installed(), 1);

// busy generating -> banner only, no restart
h = harness({ busy: true });
h.au.emit('update-downloaded', { version: '0.3.0' });
h.fire();
assert.strictEqual(h.sent.at(-1), 'ready');
assert.strictEqual(h.installed(), 0);

// long after launch -> banner only
h = harness();
h.advance(updater.LAUNCH_WINDOW_MS + 1);
h.au.emit('update-downloaded', { version: '0.3.0' });
assert.strictEqual(h.sent.at(-1), 'ready');

// dev build never touches the network
h = harness({ packaged: false });
assert.strictEqual(h.u.status().state, 'dev');
h.u.check().then((s) => { assert.strictEqual(s.state, 'dev'); console.log('updater: ok'); });
