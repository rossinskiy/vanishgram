// Browser notifications. Off by default. The text of a message is never shown unless the person opts in,
// because notifications pass through the operating system, which is outside Vanishgram's encryption.
// Browser limit: they only appear while a Vanishgram tab is open. The Android app also listens in the background (see syncPush).
export type NotifyMode = 'hidden' | 'sender' | 'full';
export interface NotifyPrefs { on: boolean; mode: NotifyMode }

const KEY = 'vg.notify';
interface PushPlugin { requestPermission(): Promise<{ granted: boolean }>; start(o: { base: string; mode: string; accounts: { id: string; label: string; token: string }[] }): Promise<void>; stop(): Promise<void> }
/** The Android app has a native listener; it cannot read messages, so it only ever says that something arrived. */
const push = (window as unknown as { Capacitor?: { Plugins?: { VgPush?: PushPlugin } } }).Capacitor?.Plugins?.VgPush;
export const nativePush = !!push;
export const notificationsSupported = nativePush || typeof Notification !== 'undefined';

export function getPrefs(): NotifyPrefs {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return { on: !!v.on, mode: v.mode === 'sender' || v.mode === 'full' ? v.mode : 'hidden' }; } catch { return { on: false, mode: 'hidden' }; }
}
export function setPrefs(p: NotifyPrefs) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } }

/** Ask the browser for permission. Must run from a click. */
export async function enableNotifications(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (!notificationsSupported) return 'unsupported';
  if (push) { try { return (await push.requestPermission()).granted ? 'granted' : 'denied'; } catch { return 'denied'; } }
  const r = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  return r === 'granted' ? 'granted' : 'denied';
}

let source: () => { base: string; accounts: { id: string; label: string; token: string }[] } = () => ({ base: '', accounts: [] });
export function setPushSource(f: typeof source) { source = f; }
/** Tell the Android background listener which signed-in accounts to watch. Call whenever sessions or the setting change. */
export function syncPush() {
  if (!push) return;
  const p = getPrefs(); const s = source();
  const run = p.on && s.accounts.length ? push.start({ base: s.base, mode: 'hidden', accounts: s.accounts }) : push.stop();
  void run.catch(() => {});
}

export function notify(o: { title: string; body: string; tag: string; onClick: () => void }) {
  const p = getPrefs();
  if (push || !p.on || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.hasFocus() && !document.hidden) return; // you are looking at the app already
  try {
    const n = new Notification(o.title, { body: o.body, tag: o.tag, icon: '/favicon.svg' });
    n.onclick = () => { window.focus(); n.close(); o.onClick(); };
    setTimeout(() => n.close(), 8000);
  } catch { /* some browsers only allow notifications from a service worker */ }
}
