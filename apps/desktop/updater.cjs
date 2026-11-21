// Self-update, built so that a hacked or coerced server cannot push malicious code to users.
// The server only hosts the files. Every release is described by release.json, signed with a key that lives on the
// maintainer's computer; the matching public key is built into this app. A new version is downloaded only if the hashes
// of its files appear in that signed list, and electron-updater then checks the download against the same hashes.
'use strict';
const { app, net } = require('electron');
const { UPDATE_PUBLIC_KEY } = require('./update-key.cjs');

const BASE = (!app.isPackaged && process.env.VG_UPDATE_URL) || 'https://vanishgram.karatel.win/updates/';
const KEY = (!app.isPackaged && process.env.VG_UPDATE_PUBKEY) || UPDATE_PUBLIC_KEY;
const { verifyRelease: verify } = require('./release-verify.cjs');
const verifyRelease = (r) => verify(r, KEY);
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };

function start(send) {
  if (process.platform === 'darwin') return { check: async () => {}, install: () => {} }; // unsigned macOS builds cannot update themselves
  if (!app.isPackaged && !process.env.VG_UPDATE_URL) return { check: async () => {}, install: () => {} };
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = true; autoUpdater.allowDowngrade = false; autoUpdater.allowPrerelease = false;
  autoUpdater.forceDevUpdateConfig = !app.isPackaged;
  autoUpdater.setFeedURL({ provider: 'generic', url: BASE });
  let signed = null, busy = false;

  autoUpdater.on('update-available', async (info) => {
    // Only files whose hashes are in the signed release are accepted.
    const ok = signed && info.version === signed.version && (info.files ?? []).length > 0 && info.files.every((f) => signed.files.some((s) => f.url.endsWith(s.name) && f.sha512 === s.sha512));
    if (!ok) { busy = false; return; }
    try { await autoUpdater.downloadUpdate(); } catch { busy = false; }
  });
  autoUpdater.on('update-downloaded', (info) => { busy = false; send({ state: 'ready', version: info.version }); });
  autoUpdater.on('error', () => { busy = false; });

  async function check() {
    if (busy) return; busy = true;
    try {
      const res = await net.fetch(BASE + 'release.json', { cache: 'no-store' });
      if (!res.ok) { busy = false; return; }
      const r = await res.json();
      if (!verifyRelease(r)) { busy = false; return; } // unsigned or wrongly signed: ignore completely
      if (!newer(r.version, app.getVersion())) { busy = false; return; }
      signed = r;
      await autoUpdater.checkForUpdates();
    } catch { busy = false; }
  }
  setTimeout(() => { void check(); }, 20_000);
  setInterval(() => { void check(); }, 6 * 3600_000).unref();
  return { check, install: () => autoUpdater.quitAndInstall(false, true) };
}

module.exports = { start };
