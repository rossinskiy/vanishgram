// The only bridge between the page and the shell. No Node, no file system, no arbitrary IPC.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Crypto engine bridge: libsignal runs in the main process; the page only ever sees results.
contextBridge.exposeInMainWorld('vgSignal', {
  open: () => ipcRenderer.invoke('vg:signal', 'open'),
  call: (handle, method, args) => ipcRenderer.invoke('vg:signal', 'call', handle, method, args),
  close: (handle) => ipcRenderer.invoke('vg:signal', 'close', handle),
});
contextBridge.exposeInMainWorld('vgDesktop', {
  info: () => ipcRenderer.invoke('vg:info'),
  /** Called with { state: 'ready', version } when a verified update has been downloaded. */
  onUpdate: (cb) => { if (typeof cb === 'function') ipcRenderer.on('vg:update', (_e, m) => { if (m && m.state === 'ready' && typeof m.version === 'string') cb({ state: 'ready', version: m.version }); }); },
  installUpdate: () => ipcRenderer.invoke('vg:install-update'),
  /** Called with a "#join=..." or "#channel=..." fragment when a vanishgram:// link is opened. */
  onLink: (cb) => { if (typeof cb === 'function') ipcRenderer.on('vg:link', (_e, frag) => { if (typeof frag === 'string') cb(frag); }); },
});
