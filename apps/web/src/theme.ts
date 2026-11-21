const KEY = 'vg.theme';
export type Theme = 'light' | 'dark';

export function currentTheme(): Theme { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }

function apply(t: Theme) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#0b1020' : '#2563EB');
}

/** Light is the default. Only an explicit user choice switches to dark. */
export function initTheme() {
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage blocked */ }
  apply(saved === 'dark' ? 'dark' : 'light');
}

export function toggleTheme() {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  apply(next);
  try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
}
