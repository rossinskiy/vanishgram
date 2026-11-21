type Child = Node | string | null | undefined | false;
type Props = Record<string, any>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...kids: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') (el as any).value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

const ICONS: Record<string, string> = {
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A9.7 9.7 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.7 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 4.4-1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2 .7 3.2 2.3 3.5 5.2"/>',
  pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>',
  channel: '<path d="M3 11v2a1 1 0 0 0 1 1h3l7 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M18 9a4 4 0 0 1 0 6"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  bellOff: '<path d="M3 3l18 18"/><path d="M8.7 4.4A6 6 0 0 1 18 9c0 3 .5 4.7 1 5.7M6 9c0 6-2 7-2 7h10"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  edit: '<path d="M4 20h4l11-11-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micOff: '<path d="M3 3l18 18"/><path d="M9 9v2a3 3 0 0 0 5 2.2M15 9.3V6a3 3 0 0 0-5.7-1.3"/><path d="M5 11a7 7 0 0 0 11.5 5.3M12 18v3"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checks: '<path d="M2 12.5l4.5 4.5L16 7.5"/><path d="M11 16l1 1L22 7.5"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  play: '<path d="M8 5l11 7-11 7z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  paperclip: '<path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 17.5a2 2 0 0 1-3-3l7.5-7.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  more: '<circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  forward: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0-6 6v3"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>',
  bookmark: '<path d="M6 4h12v17l-6-4-6 4z"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9.5h.01M15 9.5h.01"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
};
export function icon(name: string): SVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] ?? '';
  return s;
}

export function iconBtn(name: string, label: string, onClick: (e: Event) => void, cls = 'icon-btn'): HTMLButtonElement {
  const b = h('button', { class: cls, type: 'button', 'aria-label': label, title: label, onClick });
  b.append(icon(name));
  return b;
}

let toastTimer: number | undefined;
export function toast(text: string) {
  document.querySelector('.toast')?.remove();
  document.body.append(h('div', { class: 'toast', role: 'status' }, text));
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => document.querySelector('.toast')?.remove(), 3200);
}

export async function copyText(text: string, ok = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(ok); } catch { toast('Copy failed. Select the text and copy it manually.'); }
}

/** Accessible modal: focus moves in, Escape closes, Tab stays inside, focus returns on close. */
export function modal(title: string, body: Node[], opts: { onClose?: () => void } = {}): { close: () => void; el: HTMLElement } {
  const prev = document.activeElement as HTMLElement | null;
  const close = () => { overlay.remove(); prev?.focus(); opts.onClose?.(); };
  const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' }, h('h2', {}, title), ...body);
  const overlay = h('div', { class: 'overlay', onMousedown: (e: Event) => { if (e.target === overlay) close(); } }, dialog);
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href]')].filter((x) => !x.hasAttribute('disabled'));
    if (!f.length) return;
    const first = f[0]!, last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.body.append(overlay);
  (dialog.querySelector<HTMLElement>('input, select, textarea') ?? dialog.querySelector<HTMLElement>('button') ?? dialog).focus();
  return { close, el: dialog };
}

export function confirmModal(title: string, text: string, confirmLabel: string, danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (!done) { done = true; m.close(); resolve(v); } };
    const m = modal(title, [
      h('p', { class: 'muted' }, text),
      h('div', { class: 'actions' },
        h('button', { class: `btn ${danger ? 'danger' : ''}`, type: 'button', onClick: () => finish(true) }, confirmLabel),
        h('button', { class: 'btn secondary', type: 'button', onClick: () => finish(false) }, 'Cancel')),
    ], { onClose: () => { if (!done) { done = true; resolve(false); } } });
  });
}

/** Password input with a visibility toggle. */
export function passwordField(id: string, label: string, opts: { autocomplete?: string; hint?: string } = {}) {
  const input = h('input', { class: 'input', id, type: 'password', autocomplete: opts.autocomplete ?? 'off', spellcheck: 'false', autocapitalize: 'off' });
  let shown = false;
  const btn = iconBtn('eye', 'Show passphrase', () => {
    shown = !shown; input.type = shown ? 'text' : 'password';
    btn.setAttribute('aria-label', shown ? 'Hide passphrase' : 'Show passphrase'); btn.title = btn.getAttribute('aria-label')!;
    btn.replaceChildren(icon(shown ? 'eyeoff' : 'eye'));
  });
  const wrap = h('div', { class: 'field' }, h('label', { for: id }, label), h('div', { class: 'pw' }, input, btn), opts.hint ? h('span', { class: 'muted small' }, opts.hint) : null);
  return { wrap, input };
}
