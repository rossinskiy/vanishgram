import { VanishClient, IdbBackend, setSignalFactory } from '@vanishgram/client-core';
import { IpcSignal, bridgeAvailable } from './signal-bridge.ts';
import { DEFAULT_LIMITS } from '@vanishgram/protocol';
import { h, toast, confirmModal } from './dom.ts';
import { initTheme } from './theme.ts';
import { startAuth } from './auth.ts';
import { startApp } from './app.ts';
import { avatarEl, askSecondFactor, uaLabel } from './profile-ui.ts';
import { notify } from './notify.ts';
import { BASE, page } from './auth.ts';
import { passwordField, modal } from './dom.ts';
import type { AccountsApi, AccountEntry } from './accounts.ts';

initTheme();
if (bridgeAvailable()) setSignalFactory(() => new IpcSignal());
VanishClient.deviceLabel = uaLabel();
// An invite link carries a secret in the URL fragment: keep it in memory and remove it from the address bar.
const joinLink = location.hash.startsWith('#join=') || location.hash.startsWith('#channel=') ? location.href : null;
if (joinLink) history.replaceState(null, '', location.pathname);
const root = document.getElementById('root')!;
let pending: string | null = joinLink;

// ---- several accounts on one device: each has its own vault, passphrase, keys and connection ----
const sessions = new Map<string, VanishClient>();      // unlocked accounts, kept online in the background
let vaultIds: string[] = [];                           // every vault on this device (unlocked or locked)
let activeId: string | null = null;
let dispose: (() => void) | null = null;
const bgUnread = new Map<string, number>();
const bgChats = new Map<string, Map<string, number>>(); // account -> chat -> unread, handed to the screen when you switch to it

const LABELS = 'vg.labels', LAST = 'vg.last';
const readLabels = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(LABELS) ?? '{}'); } catch { return {}; } };
const labelOf = (id: string) => readLabels()[id] ?? `Account ${id.slice(0, 8)}`;
const lastId = () => { try { return localStorage.getItem(LAST); } catch { return null; } };

function retitle() {
  const n = [...bgUnread.values()].reduce((a, b) => a + b, 0);
  if (!document.hidden && document.title.startsWith('(')) document.title = 'Vanishgram';
  if (n && document.hidden) document.title = `(${n}) Vanishgram`;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Vanishgram'; else for (const c of sessions.values()) void c.flush().catch(() => {}); });
window.addEventListener('pagehide', () => { for (const c of sessions.values()) void c.flush().catch(() => {}); });

/** A signed-in account that is not on screen still counts new messages and reconnects on its own. */
function background(c: VanishClient) {
  const id = c.account.accountId;
  c.onMessage = (peer, msg) => { if (activeId !== id) {
    if (msg.from !== c.account.accountId && !msg.sys && !c.muted.has(peer)) notify({ title: 'Vanishgram', body: `New message in ${labelOf(id)}`, tag: `acct-${id}`, onClick: () => api.switchTo(id) }); bgUnread.set(id, (bgUnread.get(id) ?? 0) + 1); const m = bgChats.get(id) ?? new Map<string, number>(); if (!c.muted.has(peer)) m.set(peer, (m.get(peer) ?? 0) + 1); bgChats.set(id, m); retitle(); } };
  c.onChange = () => {}; c.onTyping = () => {}; c.onCall = () => {};
  c.onSessionLost = () => { toast(`${labelOf(id)} was signed out from another device.`); void c.wipe().catch(() => {}); api.loggedOut(id); };
  let attempt = 0;
  const reconnect = () => { if (!sessions.has(id) || activeId === id) return; c.connect().then(() => { attempt = 0; }, () => setTimeout(reconnect, Math.min(30000, 1000 * 2 ** attempt++))); };
  c.onDisconnect = () => setTimeout(reconnect, 1000);
  if (!c.connected) reconnect();
}

const api: AccountsApi = {
  max: DEFAULT_LIMITS.maxSignedInAccounts,
  entries(): AccountEntry[] {
    return vaultIds.map((id) => ({ id, label: labelOf(id), active: id === activeId, locked: !sessions.has(id), unread: bgUnread.get(id) ?? 0, client: sessions.get(id) ?? null }));
  },
  canAdd: () => vaultIds.length < DEFAULT_LIMITS.maxSignedInAccounts,
  switchTo(id) { if (sessions.has(id)) show(id); else unlockDialog(id); },
  add() {
    dispose?.(); dispose = null;
    const prev = activeId;
    startAuth(root, (c) => { adopt(c); show(c.account.accountId); }, {
      add: true, signedIn: () => new Set(vaultIds), labelOf,
      onCancel: () => { if (prev && sessions.has(prev)) show(prev); else boot(); },
    }).catch(() => boot());
  },
  loggedOut(id) {
    const c = sessions.get(id); c?.close();
    sessions.delete(id); bgUnread.delete(id); vaultIds = vaultIds.filter((x) => x !== id);
    const labels = readLabels(); delete labels[id]; try { localStorage.setItem(LABELS, JSON.stringify(labels)); } catch { /* ignore */ }
    dispose?.(); dispose = null; activeId = null;
    const next = [...sessions.keys()][0] ?? vaultIds[0];
    if (next && sessions.has(next)) show(next); else boot();
  },
  async logoutAll() {
    for (const [id, c] of sessions) { await c.wipe().catch(() => {}); sessions.delete(id); }
    for (const id of vaultIds) await new IdbBackend(id).remove().catch(() => {}); // locked accounts: local data goes, their device entry expires on the server
    vaultIds = []; bgUnread.clear(); dispose?.(); dispose = null; activeId = null;
    try { localStorage.removeItem(LABELS); localStorage.removeItem(LAST); } catch { /* ignore */ }
    boot();
  },
  takeUnread(id) { const m = bgChats.get(id) ?? new Map<string, number>(); bgChats.delete(id); return m; },
  setLabel(id, label) { const l = readLabels(); if (l[id] !== label) { l[id] = label; try { localStorage.setItem(LABELS, JSON.stringify(l)); } catch { /* ignore */ } } },
};

function adopt(c: VanishClient) {
  const id = c.account.accountId;
  sessions.set(id, c);
  if (!vaultIds.includes(id)) vaultIds.push(id);
}

// Desktop app: a vanishgram:// link was opened. Show it in the active account (the link keeps its secret in the fragment only).
declare global { interface Window { vgDesktop?: { onLink(cb: (frag: string) => void): void; onUpdate?(cb: (m: { state: 'ready'; version: string }) => void): void; installUpdate?(): Promise<void> } } }
// A verified update was downloaded in the background: offer to restart into it.
window.vgDesktop?.onUpdate?.((m) => {
  const bar = h('div', { class: 'notice-bar', role: 'status' }, h('span', {}, `Vanishgram ${m.version} is ready.`),
    h('button', { class: 'btn', type: 'button', onClick: () => { void window.vgDesktop?.installUpdate?.(); } }, 'Restart and update'),
    h('button', { class: 'btn secondary', type: 'button', onClick: () => bar.remove() }, 'Later'));
  document.body.prepend(bar);
});
window.vgDesktop?.onLink((frag) => { pending = 'https://vanishgram.karatel.win/' + frag; if (activeId) show(activeId); });

function show(id: string) {
  const prev = activeId ? sessions.get(activeId) : null;
  dispose?.(); dispose = null;
  if (prev && activeId !== id) background(prev);
  activeId = id; bgUnread.delete(id); retitle();
  try { localStorage.setItem(LAST, id); } catch { /* ignore */ }
  const j = pending; pending = null;
  dispose = startApp(root, sessions.get(id)!, api, j);
}

function unlockDialog(id: string) {
  const pw = passwordField('uq', 'Passphrase', { autocomplete: 'current-password' });
  const err = h('p', { class: 'msg-error', role: 'alert' });
  const go = h('button', { class: 'btn', type: 'submit' }, 'Unlock');
  const m = modal(`Unlock ${labelOf(id)}`, [h('form', { onSubmit: async (e: Event) => {
    e.preventDefault(); err.textContent = ''; go.disabled = true;
    try {
      const c = await VanishClient.open(BASE, new IdbBackend(id), pw.input.value, askSecondFactor);
      if (!c) throw new Error('missing');
      m.close(); adopt(c); show(id);
    } catch (e2) { err.textContent = (e2 as Error).name === 'WrongPassphraseError' || /passphrase/.test((e2 as Error).message) ? 'Wrong passphrase.' : 'Could not unlock. Check your connection.'; go.disabled = false; }
  } }, pw.wrap, err, h('div', { class: 'actions' }, go, h('button', { class: 'btn secondary', type: 'button', onClick: () => m.close() }, 'Cancel')))]);
}

function boot() {
  startAuth(root, (client) => { vaultIds = vaultIds.length ? vaultIds : []; adopt(client); void IdbBackend.list().then((l) => { vaultIds = [...new Set([...l, ...vaultIds])]; }).catch(() => {}); show(client.account.accountId); }, { labelOf, lastId: lastId(), signedIn: () => new Set(vaultIds) }).then(() => {
    void IdbBackend.list().then((l) => { vaultIds = [...new Set([...l, ...vaultIds])]; }).catch(() => {});
  }).catch(() => {
    root.replaceChildren(h('div', { class: 'boot', role: 'alert' }, h('p', {}, 'Vanishgram could not start. Reload the page.')));
  });
}

// Simple notice: we set no tracking cookies. Local storage keeps the theme and encrypted data.
function notice() {
  try { if (localStorage.getItem('vg.notice') === '1') return; } catch { return; }
  const bar = h('div', { class: 'cookie', role: 'region', 'aria-label': 'Storage notice' },
    h('span', { class: 'grow' }, 'No tracking cookies. This site stores your theme and your encrypted account data in your browser only. ', h('a', { href: page('/privacy') }, 'Details')),
    h('button', { class: 'btn secondary', type: 'button', onClick: () => { try { localStorage.setItem('vg.notice', '1'); } catch { /* ignore */ } bar.remove(); } }, 'OK'));
  document.body.append(bar);
}

void IdbBackend.list().then((l) => { vaultIds = l; }).catch(() => {});
boot();
notice();
void toast; void confirmModal; void avatarEl;
