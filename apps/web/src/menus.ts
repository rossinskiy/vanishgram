import { h, icon } from './dom.ts';

export interface MenuItem { label: string; icon?: string; danger?: boolean; checked?: boolean; hidden?: boolean; onClick: () => void }
type Anchor = HTMLElement | { x: number; y: number };

let closeCurrent: (() => void) | null = null;

function place(el: HTMLElement, at: Anchor, prefer: 'below' | 'above' = 'below') {
  const vw = window.innerWidth, vh = window.innerHeight;
  const r = el.getBoundingClientRect();
  let x: number, y: number;
  if (at instanceof HTMLElement) {
    const a = at.getBoundingClientRect();
    x = a.right - r.width; y = prefer === 'below' ? a.bottom + 6 : a.top - r.height - 6;
    if (y + r.height > vh - 8) y = a.top - r.height - 6;
    if (y < 8) y = Math.min(a.bottom + 6, vh - r.height - 8);
  } else { x = at.x; y = at.y; if (x + r.width > vw - 8) x = at.x - r.width; if (y + r.height > vh - 8) y = at.y - r.height; }
  el.style.left = `${Math.max(8, Math.min(x, vw - r.width - 8))}px`;
  el.style.top = `${Math.max(8, y)}px`;
}

function mount(el: HTMLElement, at: Anchor, prefer?: 'below' | 'above'): () => void {
  closeCurrent?.();
  const prev = document.activeElement as HTMLElement | null;
  const close = () => { el.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', close); if (closeCurrent === close) closeCurrent = null; prev?.focus?.(); };
  const outside = (e: Event) => { if (!el.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    const items = [...el.querySelectorAll<HTMLElement>('[role="menuitem"], .rx')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  };
  document.body.append(el);
  place(el, at, prefer);
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);
  closeCurrent = close;
  (el.querySelector<HTMLElement>('[role="menuitem"], .rx') ?? el).focus();
  return close;
}

export function showMenu(at: Anchor, items: (MenuItem | 'sep' | null | false)[], reactions?: { current?: string; onPick: (emoji: string | null) => void }): () => void {
  let close: () => void = () => {};
  const nodes: Node[] = [];
  if (reactions) nodes.push(h('div', { class: 'rx-row', role: 'group', 'aria-label': 'Reactions' }, REACTIONS.map((e) => h('button', { class: `rx ${reactions.current === e ? 'on' : ''}`, type: 'button', role: 'menuitem', 'aria-label': `React ${e}`, 'aria-pressed': String(reactions.current === e), onClick: () => { close(); reactions.onPick(reactions.current === e ? null : e); } }, e))), h('div', { class: 'menu-sep', role: 'separator' }));
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') { nodes.push(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
    if (it.hidden) continue;
    nodes.push(h('button', { class: `menu-item ${it.danger ? 'danger' : ''}`, type: 'button', role: 'menuitem', onClick: () => { close(); it.onClick(); } },
      it.icon ? icon(it.icon) : h('span', { class: 'menu-gap' }), h('span', { class: 'grow' }, it.label), it.checked ? icon('check') : null));
  }
  close = mount(h('div', { class: 'menu', role: 'menu', tabindex: '-1' }, ...nodes), at);
  return close;
}

/** The six quick reactions. Escapes keep the source readable and ASCII. */
export const REACTIONS = ['\u{1F44D}', '❤️', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F525}'];

export function showReactionBar(at: Anchor, current: string | undefined, onPick: (emoji: string | null) => void): () => void {
  let close: () => void = () => {};
  const bar = h('div', { class: 'reaction-bar', role: 'menu', 'aria-label': 'Reactions', tabindex: '-1' },
    REACTIONS.map((e, i) => h('button', { class: `rx ${current === e ? 'on' : ''}`, type: 'button', role: 'menuitem', 'aria-label': `React ${e}`, 'aria-pressed': String(current === e), 'data-i': String(i),
      onClick: () => { close(); onPick(current === e ? null : e); } }, e)));
  close = mount(bar, at, 'above');
  return close;
}
