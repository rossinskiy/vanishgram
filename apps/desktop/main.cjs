// Vanishgram desktop shell (Electron main process).
// The interface is the same bundle as before, but it is shipped INSIDE the app and loaded from app://vanishgram,
// so the server can no longer swap the JavaScript that handles your keys. Only the network API is remote.
'use strict';
const { app, BrowserWindow, protocol, shell, session, Menu, ipcMain, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const API_HOST = 'vanishgram.karatel.win';
const APP_ORIGIN = 'app://vanishgram';
const ROOT = path.join(__dirname, 'app');

const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  `connect-src 'self' https://${API_HOST} wss://${API_HOST} https://stun.cloudflare.com https://rtc.live.cloudflare.com`,
  "manifest-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

// One instance only. A second launch (or a vanishgram:// link) is handed to the running one.
const single = app.requestSingleInstanceLock();
if (!single) app.quit();

let win = null;
let pendingLink = null;

const linkFrom = (argv) => argv.find((a) => a.startsWith('vanishgram://')) ?? null;
// vanishgram://open#join=...  or  vanishgram://open#channel=name  ->  "#join=..." fragment for the interface
const fragmentOf = (link) => { try { const u = new URL(link); return u.hash.startsWith('#join=') || u.hash.startsWith('#channel=') ? u.hash : null; } catch { return null; } };
function deliver(link) {
  const frag = link && fragmentOf(link);
  if (!frag) return;
  if (win && !win.webContents.isLoading()) win.webContents.send('vg:link', frag); else pendingLink = frag;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 360, minHeight: 520, backgroundColor: '#ffffff', title: 'Vanishgram', show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, webSecurity: true },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => { if (pendingLink) { win.webContents.send('vg:link', pendingLink); pendingLink = null; } });
  // The window can only ever show our own bundle. Anything else opens in the normal browser (https only) or is dropped.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(APP_ORIGIN + '/')) { e.preventDefault(); if (/^https:\/\//.test(url)) void shell.openExternal(url); } });
  if (process.env.VG_SMOKE) { // self-test used by the build script: load the UI, report what is there, exit
    win.webContents.on('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const js = 'JSON.stringify({ title: document.title, bridge: typeof window.vgDesktop, ui: document.getElementById("root").children.length, wasm: typeof WebAssembly.compile })';
      console.log('SMOKE ' + await win.webContents.executeJavaScript(js));
      app.exit(0);
    });
  }
  void win.loadURL(APP_ORIGIN + '/index.html');
}

app.on('second-instance', (_e, argv) => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } deliver(linkFrom(argv)); });
app.on('open-url', (e, url) => { e.preventDefault(); deliver(url); }); // macOS

app.whenReady().then(() => {
  app.setAsDefaultProtocolClient('vanishgram');
  pendingLink = (linkFrom(process.argv) && fragmentOf(linkFrom(process.argv))) || null;

  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) return new Response('not found', { status: 404 });
    try {
      const res = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(res.headers);
      headers.set('content-security-policy', CSP);
      headers.set('x-content-type-options', 'nosniff'); headers.set('referrer-policy', 'no-referrer');
      return new Response(res.body, { status: res.status, headers });
    } catch { return new Response('not found', { status: 404 }); }
  });

  // Permissions: microphone for calls and notifications, nothing else. Only from our own pages.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const ours = (details.requestingUrl || '').startsWith(APP_ORIGIN + '/');
    cb(ours && (permission === 'media' || permission === 'notifications'));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => origin === APP_ORIGIN && (permission === 'media' || permission === 'notifications'));

  // libsignal lives here, in the main process. The page can only call the listed methods, and only from our own bundle.
  const METHODS = new Set(['create', 'load', 'save', 'identityKey', 'registrationId', 'signedPrekey', 'kyberPrekey', 'newOneTimePrekeys', 'oneTimePrekeyCount',
    'rotatePrekeys', 'verify', 'trust', 'hasSession', 'processBundle', 'encrypt', 'decrypt', 'dropSession']);
  const engines = new Map(); let nextEngine = 1; let EngineClass = null;
  ipcMain.handle('vg:signal', async (e, op, handle, method, args) => {
    if (!(e.senderFrame && e.senderFrame.url.startsWith(APP_ORIGIN + '/'))) throw new Error('forbidden');
    if (op === 'open') {
      EngineClass ??= (await import(pathToFileURL(path.join(__dirname, 'signal-engine.mjs')).href)).SignalEngine;
      const id = nextEngine++; engines.set(id, new EngineClass()); return id;
    }
    if (op === 'close') { engines.delete(handle); return; }
    const eng = engines.get(handle);
    if (op !== 'call' || !eng || !METHODS.has(method) || !Array.isArray(args)) throw new Error('bad request');
    return eng[method](...args);
  });
  app.on('web-contents-created', (_e, wc) => wc.on('did-start-navigation', (_ev, _url, _inPlace, isMainFrame) => { if (isMainFrame) engines.clear(); })); // a reload starts with fresh engines

  const updater = require('./updater.cjs').start((msg) => { if (win && !win.isDestroyed()) win.webContents.send('vg:update', msg); });
  ipcMain.handle('vg:install-update', (e) => { if (e.senderFrame && e.senderFrame.url.startsWith(APP_ORIGIN + '/')) updater.install(); });

  ipcMain.handle('vg:info', () => ({ version: app.getVersion(), platform: process.platform }));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
