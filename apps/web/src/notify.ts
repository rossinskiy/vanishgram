// Browser notifications. Off by default. The text of a message is never shown unless the person opts in,
// because notifications pass through the operating system, which is outside Vanishgram's encryption.
// Limits: they only appear while a Vanishgram tab is open (there is no push service yet).
export type NotifyMode = 'hidden' | 'sender' | 'full';
export interface NotifyPrefs { on: boolean; mode: NotifyMode }

const KEY = 'vg.notify';
export const notificationsSupported = typeof Notification !== 'undefined';

export function getPrefs(): NotifyPrefs {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return { on: !!v.on, mode: v.mode === 'sender' || v.mode === 'full' ? v.mode : 'hidden' }; } catch { return { on: false, mode: 'hidden' }; }
}
export function setPrefs(p: NotifyPrefs) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } }

/** Ask the browser for permission. Must run from a click. */
export async function enableNotifications(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (!notificationsSupported) return 'unsupported';
  const r = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  return r === 'granted' ? 'granted' : 'denied';
}

export function notify(o: { title: string; body: string; tag: string; onClick: () => void }) {
  const p = getPrefs();
  if (!p.on || !notificationsSupported || Notification.permission !== 'granted') return;
  if (document.hasFocus() && !document.hidden) return; // you are looking at the app already
  try {
    const n = new Notification(o.title, { body: o.body, tag: o.tag, icon: '/favicon.svg' });
    n.onclick = () => { window.focus(); n.close(); o.onClick(); };
    setTimeout(() => n.close(), 8000);
  } catch { /* some browsers only allow notifications from a service worker */ }
}
