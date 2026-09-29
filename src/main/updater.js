'use strict';
/**
 * Self-update on launch, via electron-updater against GitHub Releases.
 *
 * The updater is injected so the decision logic is testable without Electron
 * or the network. Behaviour:
 *   - check as soon as the app is ready (packaged builds only);
 *   - download in the background;
 *   - if that finishes within LAUNCH_WINDOW_MS and nothing is generating, restart
 *     straight into the new version - i.e. it updates "on launch";
 *   - otherwise show a "restart to update" banner, and install on quit anyway,
 *     so a mid-session update never throws away a prompt or an in-flight render.
 * Failures (offline, no release published yet) are silent apart from Settings.
 */

const LAUNCH_WINDOW_MS = 90_000;
const RESTART_DELAY_MS = 2_500;   // long enough to read the banner

function shouldAutoRestart({ sinceLaunchMs, busy }) {
  return !busy && sinceLaunchMs <= LAUNCH_WINDOW_MS;
}

function init({ autoUpdater, packaged, version, send, isBusy, now = Date.now, setTimer = setTimeout }) {
  const launchedAt = now();
  let status = { state: packaged ? 'idle' : 'dev', version };

  const set = (patch) => {
    status = { version, ...patch };
    send(status);
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'current' }));
  autoUpdater.on('update-available', (i) => set({ state: 'downloading', next: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', next: status.next, percent: Math.round(p.percent || 0) }));
  autoUpdater.on('error', (e) => set({ state: 'error', message: String(e?.message || e).split('\n')[0] }));

  autoUpdater.on('update-downloaded', (i) => {
    if (shouldAutoRestart({ sinceLaunchMs: now() - launchedAt, busy: isBusy() })) {
      set({ state: 'restarting', next: i.version });
      setTimer(() => autoUpdater.quitAndInstall(true, true), RESTART_DELAY_MS);
    } else {
      set({ state: 'ready', next: i.version });
    }
  });

  return {
    status: () => status,
    check() {
      if (!packaged) return Promise.resolve(status);
      return autoUpdater.checkForUpdates().then(() => status).catch((e) => {
        set({ state: 'error', message: String(e?.message || e).split('\n')[0] });
        return status;
      });
    },
    install: () => autoUpdater.quitAndInstall(true, true),
  };
}

module.exports = { init, shouldAutoRestart, LAUNCH_WINDOW_MS };
