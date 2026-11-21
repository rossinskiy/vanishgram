import { VanishClient, IdbBackend, safetyNumber, verifyBundle, unb64, TTL_CHOICES, type ChatMessage } from '@vanishgram/client-core';
import { DEFAULT_LIMITS, type PrekeyBundleWire, type FileInfo } from '@vanishgram/protocol';
import { h, icon, iconBtn, toast, copyText, modal, confirmModal } from './dom.ts';
import { toggleTheme, currentTheme } from './theme.ts';
import { createWebPeerFactory, callsSupported, listAudioDevices, setSpeaker, currentSpeaker, speakerSelectionSupported } from './rtc.ts';
import type { CallState } from '@vanishgram/client-core';
import { avatarEl, colorClass, editProfileDialog, privacyDialog, securityDialog, devicesDialog, reportDialog } from './profile-ui.ts';
import type { AccountsApi } from './accounts.ts';
import { BASE, page } from './auth.ts';
import { getPrefs, setPrefs, enableNotifications, notify, notificationsSupported, type NotifyMode } from './notify.ts';
import { showMenu } from './menus.ts';
import { attachmentNode, sendFiles, uploads, uploadNode, onUploadsChange, Recorder, fmtDur } from './media.ts';

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const shortDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const GROUP_GAP = 5 * 60_000;

export function startApp(root: HTMLElement, client: VanishClient, api: AccountsApi, joinLink: string | null = null): () => void {
  const me = client.account.accountId;
  const onLogout = () => api.loggedOut(me);
  let disposed = false;
  const cleanups: (() => void)[] = [];
  const listen = <K extends keyof DocumentEventMap>(ev: K, fn: (e: DocumentEventMap[K]) => void) => { document.addEventListener(ev, fn as EventListener); cleanups.push(() => document.removeEventListener(ev, fn as EventListener)); };
  let active: string | null = null;
  let replyTo: ChatMessage | null = null;
  let editing: ChatMessage | null = null;
  let tab = 'all';
  let search = '';
  let archivedView = false;
  let recorder: Recorder | null = null;
  let connected = false;
  const unread = new Map<string, number>(api.takeUnread(me));
  let raf = 0;
  let presenceTimer = 0;
  const msgCache = new Map<string, { sig: string; el: HTMLElement }>();
  const seenIds = new Set<string>();

  const isGroup = (id: string) => id.startsWith('g:');
  const gid = (id: string) => id.slice(2);
  const grp = (id: string) => client.groups.get(gid(id));
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const isPub = (id: string) => id.startsWith('c:');
  const pubCh = (id: string) => client.channels.get(gid(id));
  const isChannel = (id: string) => isPub(id) || (isGroup(id) && grp(id)?.kind === 'channel');
  const isSaved = (id: string) => id === me;
  const kindOf = (id: string): 'saved' | 'dm' | 'group' | 'channel' => isSaved(id) ? 'saved' : isChannel(id) ? 'channel' : isGroup(id) ? 'group' : 'dm';
  const person = (id: string) => { const ct = id === me ? { displayName: client.profile.me.displayName, username: client.contacts.get(me)?.username } : client.contacts.get(id); return ct?.displayName || (ct?.username ? `@${ct.username}` : `Account ${id.slice(0, 8)}`); };
  const label = (id: string) => isSaved(id) ? 'Saved messages' : isPub(id) ? (pubCh(id)?.title || 'Channel') : isGroup(id) ? (grp(id)?.name || (grp(id)?.kind === 'channel' ? 'Channel' : 'Group')) : person(id);
  const initial = (id: string) => isGroup(id) || isPub(id) ? label(id).slice(0, 1).toUpperCase() : (client.contacts.get(id)?.displayName || client.contacts.get(id)?.username || id).slice(0, 1).toUpperCase();
  const myRole = (id: string) => isPub(id) ? pubCh(id)?.role : grp(id)?.members.find((m) => m.accountId === me)?.role;
  const amAdmin = (id: string) => myRole(id) === 'owner' || myRole(id) === 'admin';
  const sortedCache = new Map<string, { len: number; first?: string; last?: string; out: ChatMessage[] }>();
  const sorted = (id: string) => {
    const l = client.chats.get(id) ?? [], c = sortedCache.get(id);
    if (c && c.len === l.length && c.first === l[0]?.id && c.last === l.at(-1)?.id) return c.out;
    let ordered = true; for (let i = 1; i < l.length; i++) if (l[i]!.ts < l[i - 1]!.ts) { ordered = false; break; }
    const out = ordered ? l : [...l].sort((a, b) => a.ts - b.ts);
    sortedCache.set(id, { len: l.length, first: l[0]?.id, last: l.at(-1)?.id, out });
    return out;
  };
  const lastMsg = (id: string) => { const l = client.chats.get(id); if (!l?.length) return undefined; const a = l[l.length - 1]!, b = l[l.length - 2]; return b && b.ts > a.ts ? b : a; };
  const lastTs = (id: string) => lastMsg(id)?.ts ?? 0;
  const kids = (...n: (Node | null | false | undefined)[]): Node[] => n.filter((x): x is Node => !!x);
  const kidsOf = kids;
  const refreshers = new Set<() => void>();
  const fileLabel = (f: FileInfo) => f.kind === 'image' ? 'Photo' : f.kind === 'video' ? 'Video' : f.kind === 'voice' ? 'Voice message' : f.kind === 'audio' ? 'Audio' : f.name;
  const letterAvatar = (id: string, cls: string) => h('span', { class: `${cls} ${colorClass(id)}` }, initial(id));
  const avatarFor = (id: string, cls = 'avatar') => isGroup(id) || isPub(id) ? letterAvatar(id, `${cls} group`) : isSaved(id) ? h('span', { class: `${cls} av-saved` }, icon('bookmark')) : avatarEl(client, id, cls);

  // ---------- skeleton ----------
  const list = h('ul', { class: 'list', 'aria-label': 'Chats' });
  const tabsEl = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Chat folders' });
  const banner = h('div', { class: 'connect-banner', role: 'status', hidden: true }, h('span', { class: 'spinner small' }), 'Connecting');
  const meName = h('span', { class: 'name' }, 'You');
  let meAvatar: HTMLElement = avatarEl(client, me);
  let meSig = '';
  const searchInput = h('input', { class: 'search-input', id: 'find', type: 'search', placeholder: 'Search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Search chats, messages, people and channels' });
  const searchBar = h('div', { class: 'searchbar' }, iconBtn('menu', 'Menu', () => openDrawer()), h('label', { class: 'search-pill', for: 'find' }, icon('search'), searchInput));
  const side = h('aside', { class: 'side' }, searchBar, banner, tabsEl, list);
  const pane = h('main', { class: 'pane', id: 'main', tabindex: '-1' });
  const app = h('div', { class: 'app' }, side, pane);
  root.replaceChildren(app);

  searchInput.addEventListener('input', () => { search = searchInput.value; renderList(); });
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchInput.value = ''; search = ''; renderList(); searchInput.blur(); } if (e.key === 'Enter') void globalFind(search); });

  async function globalFind(raw: string) {
    const q = raw.trim().replace(/^@/, '');
    if (!q) return;
    try { const id = await client.startChat(q); searchInput.value = ''; search = ''; open(id); }
    catch (err) {
      if ((err as any)?.status === 404) {
        try { const ch = await client.ch.lookup(q); searchInput.value = ''; search = ''; open(`c:${ch.id}`); return; } catch { /* fall through */ }
        toast('No person or public channel with that username.'); return;
      }
      toast((err as any)?.status === 429 ? 'Too many searches. Wait a minute.' : 'Search failed. Try again.');
    }
  }

  // ---------- chat list ----------
  const isToday = (ts: number) => new Date(ts).toDateString() === new Date().toDateString();
  const stamp = (ts: number) => !ts ? '' : isToday(ts) ? timeFmt.format(ts) : Date.now() - ts < 6 * 86400_000 ? weekday.format(ts) : shortDay.format(ts);
  const tickFor = (m: ChatMessage, chat: string) => (m.from !== me || isGroup(chat) || isPub(chat) || isSaved(chat)) ? null : h('span', { class: `tick ${m.read ? 'read' : m.delivered ? 'delivered' : 'sent'}`, 'aria-label': m.read ? 'Read' : m.delivered ? 'Delivered' : 'Sent' }, icon(m.read || m.delivered ? 'checks' : 'check'));

  function allChatIds(): string[] {
    const ids = new Set<string>(client.chats.keys());
    return [...ids].filter((id) => !(isPub(id) && !pubCh(id)?.role && id !== active) && (!isSaved(id) || lastTs(id) > 0 || id === active));
  }
  function visibleIds(): string[] {
    const prefs = client.prefs;
    let ids = allChatIds().filter((id) => archivedView ? prefs.archived.includes(id) : !prefs.archived.includes(id));
    if (tab === 'dm') ids = ids.filter((id) => kindOf(id) === 'dm' || kindOf(id) === 'saved');
    else if (tab === 'group') ids = ids.filter((id) => kindOf(id) === 'group');
    else if (tab === 'channel') ids = ids.filter((id) => kindOf(id) === 'channel');
    else if (tab !== 'all') { const f = prefs.folders.find((x) => x.id === tab); ids = ids.filter((id) => f?.chats.includes(id)); }
    const pin = (id: string) => prefs.pinned.indexOf(id);
    return ids.sort((a, b) => (pin(a) >= 0 ? 0 : 1) - (pin(b) >= 0 ? 0 : 1) || (pin(a) >= 0 && pin(b) >= 0 ? pin(a) - pin(b) : lastTs(b) - lastTs(a)));
  }
  const unreadIn = (ids: string[]) => ids.reduce((n, id) => n + (client.muted.has(id) ? 0 : unread.get(id) ?? 0), 0);

  function renderTabs() {
    const all = allChatIds().filter((id) => !client.prefs.archived.includes(id));
    const defs: { id: string; text: string; ids: string[] }[] = [{ id: 'all', text: 'All', ids: all }];
    const dm = all.filter((id) => ['dm', 'saved'].includes(kindOf(id))), gr = all.filter((id) => kindOf(id) === 'group'), ch = all.filter((id) => kindOf(id) === 'channel');
    if (dm.length && (gr.length || ch.length)) defs.push({ id: 'dm', text: 'Personal', ids: dm });
    if (gr.length) defs.push({ id: 'group', text: 'Groups', ids: gr });
    if (ch.length) defs.push({ id: 'channel', text: 'Channels', ids: ch });
    for (const f of client.prefs.folders) defs.push({ id: f.id, text: f.name, ids: all.filter((id) => f.chats.includes(id)) });
    if (!defs.some((d) => d.id === tab)) tab = 'all';
    tabsEl.hidden = defs.length < 2 && !archivedView;
    tabsEl.replaceChildren(...defs.map((d) => {
      const n = unreadIn(d.ids);
      return h('button', { class: `tab ${tab === d.id && !archivedView ? 'on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(tab === d.id && !archivedView), onClick: () => { tab = d.id; archivedView = false; renderList(); } }, d.text, n ? h('span', { class: 'tab-count' }, String(n)) : null);
    }));
  }

  function previewNode(id: string, last: ChatMessage | undefined): Node {
    if ((typingUntil.get(id) ?? 0) > Date.now()) return h('span', { class: 'typing-text' }, 'typing', h('span', { class: 'dots' }, h('i'), h('i'), h('i')));
    const draft = client.x.draft(id);
    if (draft && id !== active) return h('span', {}, h('span', { class: 'draft' }, 'Draft: '), draft);
    if (!last) return h('span', {}, 'No messages yet');
    const who = isChannel(id) || last.sys ? '' : last.from === me ? 'You: ' : isGroup(id) ? `${person(last.from)}: ` : '';
    const text = last.file ? `${fileLabel(last.file)}${last.body ? `: ${last.body}` : ''}` : last.body;
    return h('span', {}, who ? h('span', { class: 'who' }, who) : null, last.file ? icon(last.file.kind === 'image' ? 'image' : last.file.kind === 'voice' || last.file.kind === 'audio' ? 'mic' : last.file.kind === 'video' ? 'play' : 'file') : null, text);
  }

  function chatRow(id: string): HTMLElement {
    const last = lastMsg(id), n = unread.get(id) ?? 0, muted = client.muted.has(id), pinned = client.x.isPinned(id);
    const row = h('li', { 'data-id': id }, h('button', { class: `chat-item ${id === active ? 'on' : ''}`, type: 'button', 'aria-current': id === active ? 'true' : 'false', onClick: () => open(id),
      onContextmenu: (e: MouseEvent) => { e.preventDefault(); chatMenu(id, { x: e.clientX, y: e.clientY }); } },
      h('span', { class: 'avatar-wrap' }, avatarFor(id, 'avatar'), (presence.get(id) === 'online' && kindOf(id) === 'dm') ? h('span', { class: 'online', 'aria-label': 'online' }) : null),
      h('span', { class: 'meta' },
        h('span', { class: 'line' }, h('span', { class: 'name' }, label(id)), muted ? h('span', { class: 'mini' }, icon('bellOff')) : null, h('span', { class: 'grow' }), last ? tickFor(last, id) : null, h('span', { class: 'time' }, last ? stamp(last.ts) : '')),
        h('span', { class: 'line' }, h('span', { class: 'preview' }, previewNode(id, last)),
          n ? h('span', { class: `badge ${muted ? 'muted' : ''}`, 'aria-label': `${n} unread` }, n > 99 ? '99+' : String(n)) : pinned ? h('span', { class: 'mini pin' }, icon('pin')) : null))));
    return row;
  }

  function emptyList(): HTMLElement {
    return h('li', { class: 'empty' }, h('div', { class: 'empty-art', 'aria-hidden': 'true' }, icon('chat'), h('i', {}), h('i', {})),
      h('h3', {}, archivedView ? 'Nothing archived' : tab === 'all' ? 'Your chats will appear here' : 'No chats in this folder'),
      h('p', {}, archivedView ? 'Archived chats stay out of the way until someone writes again.' : 'Search for a friend by @username, start a group, or open a channel.'),
      archivedView ? null : h('div', { class: 'row wrap center' }, h('button', { class: 'btn', type: 'button', onClick: () => searchInput.focus() }, icon('search'), 'Find people'), h('button', { class: 'btn secondary', type: 'button', onClick: newGroupDialog }, icon('users'), 'New group')));
  }

  function renderSearchResults() {
    const q = search.trim(), nq = q.replace(/^@/, '').toLowerCase();
    const nodes: Node[] = [];
    const byName = allChatIds().filter((id) => label(id).toLowerCase().includes(nq) || (client.contacts.get(id)?.username ?? '').includes(nq));
    nodes.push(h('li', { class: 'result-head' }, 'People and channels'));
    nodes.push(h('li', {}, h('button', { class: 'chat-item', type: 'button', onClick: () => void globalFind(q) }, h('span', { class: 'avatar-wrap' }, h('span', { class: 'avatar av-find' }, icon('search'))), h('span', { class: 'meta' }, h('span', { class: 'name' }, `Find @${nq}`), h('span', { class: 'preview' }, 'Look up a username or public channel')))));
    if (byName.length) { nodes.push(h('li', { class: 'result-head' }, 'Chats')); for (const id of byName.slice(0, 20)) nodes.push(chatRow(id)); }
    const hits = client.x.search(q, { limit: 40 });
    if (hits.length) {
      nodes.push(h('li', { class: 'result-head' }, 'Messages'));
      for (const hit of hits) {
        const m = hit.message, body = m.file && !m.body ? fileLabel(m.file) : m.body, at = body.toLowerCase().indexOf(nq), from = Math.max(0, at - 24);
        const snippet = body.slice(from, from + 90);
        nodes.push(h('li', {}, h('button', { class: 'chat-item', type: 'button', onClick: () => { searchInput.value = ''; search = ''; open(hit.chat, m.id); } },
          h('span', { class: 'avatar-wrap' }, avatarFor(hit.chat, 'avatar')), h('span', { class: 'meta' },
            h('span', { class: 'line' }, h('span', { class: 'name' }, label(hit.chat)), h('span', { class: 'grow' }), h('span', { class: 'time' }, stamp(m.ts))),
            h('span', { class: 'preview' }, from > 0 ? '...' : '', snippet)))));
      }
    }
    list.replaceChildren(...nodes);
  }

  let listSig = '';
  function renderList() {
    renderTabs();
    const vis = visibleIds();
    const sig = [tab, archivedView, search, active, client.prefs.ts, client.prefs.archived.length, client.muted.size, ...vis.map((id) => { const l = lastMsg(id); return [id, l?.id, l?.body, l?.read, l?.delivered, l?.exp, unread.get(id) ?? 0, label(id), (typingUntil.get(id) ?? 0) > Date.now(), client.x.draft(id), presence.get(id), client.contacts.get(id)?.avatarVersion].join('~'); })].join('|');
    if (sig === listSig && search.trim().length < 2) return;
    listSig = sig;
    if (search.trim().length >= 2) { renderSearchResults(); return; }
    const ids = visibleIds();
    const nodes: Node[] = [];
    if (!archivedView && client.prefs.archived.length) {
      nodes.push(h('li', {}, h('button', { class: 'chat-item archive-row', type: 'button', onClick: () => { archivedView = true; renderList(); } }, h('span', { class: 'avatar-wrap' }, h('span', { class: 'avatar av-archive' }, icon('archive'))), h('span', { class: 'meta' }, h('span', { class: 'name' }, 'Archived chats'), h('span', { class: 'preview' }, plural(client.prefs.archived.length, 'chat'))))));
    }
    if (archivedView) nodes.push(h('li', {}, h('button', { class: 'chat-item archive-row', type: 'button', onClick: () => { archivedView = false; renderList(); } }, h('span', { class: 'avatar-wrap' }, h('span', { class: 'avatar av-archive' }, icon('back'))), h('span', { class: 'meta' }, h('span', { class: 'name' }, 'Archived chats'), h('span', { class: 'preview' }, 'Back to all chats')))));
    if (!ids.length) nodes.push(emptyList()); else for (const id of ids) nodes.push(chatRow(id));
    list.replaceChildren(...nodes);
  }

  // ---------- drawer ----------
  function openDrawer() {
    const prev = document.activeElement as HTMLElement | null;
    const close = () => { overlay.classList.remove('open'); setTimeout(() => { overlay.remove(); prev?.focus(); }, 220); document.removeEventListener('keydown', onKey); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const item = (ic: string, text: string, fn: () => void, extra?: Node) => h('button', { class: 'drawer-item', type: 'button', onClick: () => { close(); fn(); } }, icon(ic), h('span', { class: 'grow' }, text), extra ?? null);
    const dark = currentTheme() === 'dark';
    const sw = h('span', { class: `switch ${dark ? 'on' : ''}`, role: 'switch', 'aria-checked': String(dark) });
    const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Menu' },
      h('div', { class: 'drawer-head' }, avatarEl(client, me, 'avatar lg'), h('div', { class: 'name big' }, client.profile.me.displayName || person(me)), h('div', { class: 'muted small' }, client.contacts.get(me)?.username ? `@${client.contacts.get(me)!.username}` : 'No username yet')),
      api.entries().length > 1 ? h('div', { class: 'drawer-accounts', role: 'group', 'aria-label': 'Accounts' }, api.entries().map((e) => h('button', { class: `acct ${e.active ? 'on' : ''}`, type: 'button', 'aria-current': e.active ? 'true' : 'false', onClick: () => { close(); if (!e.active) api.switchTo(e.id); } },
        e.client ? avatarEl(e.client, e.id, 'avatar xs') : h('span', { class: `avatar xs ${colorClass(e.id)}` }, e.label.replace(/^@/, '').slice(0, 1).toUpperCase()),
        h('span', { class: 'grow name' }, e.label, e.locked ? h('span', { class: 'muted small' }, '  locked') : null),
        e.unread ? h('span', { class: 'badge' }, e.unread > 99 ? '99+' : String(e.unread)) : null, e.active ? icon('check') : null))) : null,
      h('nav', { class: 'drawer-nav' },
        item('bookmark', 'Saved messages', () => open(me)), item('users', 'New group', newGroupDialog), item('channel', 'New channel', newChannelDialog),
        item('folder', 'Chat folders', () => foldersDialog()), item('archive', 'Archived chats', () => { archivedView = true; renderList(); }),
        api.canAdd() ? item('plus', `Add account (${api.entries().length} of ${api.max})`, () => api.add()) : null,
        item('settings', 'Settings', openSettings),
        h('button', { class: 'drawer-item', type: 'button', onClick: () => { toggleTheme(); const on = currentTheme() === 'dark'; sw.classList.toggle('on', on); sw.setAttribute('aria-checked', String(on)); } }, icon(dark ? 'moon' : 'sun'), h('span', { class: 'grow' }, 'Night mode'), sw)),
      h('div', { class: 'drawer-foot muted small' }, 'Vanishgram, end-to-end encrypted. ', h('a', { href: page('/privacy'), target: '_blank', rel: 'noopener' }, 'Privacy'), ' · ', h('a', { href: page('/terms'), target: '_blank', rel: 'noopener' }, 'Terms')));
    const overlay = h('div', { class: 'drawer-overlay', onMousedown: (e: Event) => { if (e.target === overlay) close(); } }, panel);
    document.body.append(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));
    (panel.querySelector('.drawer-item') as HTMLElement).focus();
    document.addEventListener('keydown', onKey);
  }

  // ---------- chat pane ----------
  let log: HTMLElement | null = null;
  let toBottom: HTMLButtonElement | null = null;
  let textarea: HTMLTextAreaElement | null = null;
  let replyBox: HTMLElement | null = null;
  let sendBtn: HTMLButtonElement | null = null;
  let counter: HTMLElement | null = null;
  let pinBox: HTMLElement | null = null;
  let subEl: HTMLElement | null = null;
  let composerRow: HTMLElement | null = null;
  const presence = new Map<string, string | null>();
  const typingUntil = new Map<string, number>();
  const dmSub = (id: string) => isSaved(id) ? 'Notes and files for yourself' : (typingUntil.get(id) ?? 0) > Date.now() ? 'typing...' : presence.get(id) === 'online' ? 'online' : presence.get(id) ? `last seen ${presence.get(id)}` : 'End-to-end encrypted';
  const chatSub = (id: string) => {
    const g = isGroup(id) ? grp(id) : undefined, pc = isPub(id) ? pubCh(id) : undefined;
    return pc ? `${plural(pc.subscribers, 'subscriber')}, public channel` : g?.kind === 'channel' ? `${plural(g.subscribers, 'subscriber')}, end-to-end encrypted` : g ? `${plural(g.members.length, 'member')}, end-to-end encrypted` : dmSub(id);
  };

  function open(id: string, focus?: string) {
    if (active && textarea) client.x.setDraft(active, textarea.value);
    active = id; replyTo = null; editing = null; unread.delete(id); msgCache.clear(); seenIds.clear();
    if (kindOf(id) === 'dm') {
      void client.resolveContact(id, true).then(() => schedule()).catch(() => {});
      const poll = () => { if (active === id) void client.profile.presence(id).then((s) => { presence.set(id, s); if (subEl && active === id) subEl.textContent = dmSub(id); }).catch(() => {}); };
      poll(); void client.profile.markRead(id);
      clearInterval(presenceTimer); presenceTimer = window.setInterval(poll, 60_000);
    }
    app.classList.add('open-chat');
    renderPane(); renderList();
    if (focus) setTimeout(() => scrollToMessage(focus), 60); else textarea?.focus();
  }
  function closeChat() { if (active && textarea) client.x.setDraft(active, textarea.value); active = null; app.classList.remove('open-chat'); renderPane(); renderList(); }

  function scrollToMessage(id: string) {
    const el = log?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
    if (!el) return toast('That message is no longer here.');
    el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600);
  }

  function placeholderPane(): HTMLElement {
    return h('div', { class: 'placeholder' }, h('div', { class: 'hero-art', 'aria-hidden': 'true' }, h('span', { class: 'b1' }), h('span', { class: 'b2' }), h('span', { class: 'b3' }), icon('lock')),
      h('h2', {}, 'Pick a chat to start'), h('p', {}, 'Everything you write is encrypted on this device before it leaves. Search for a friend by @username, or open a group or channel.'),
      h('div', { class: 'row wrap center' }, h('button', { class: 'btn', type: 'button', onClick: () => searchInput.focus() }, icon('search'), 'Find people'), h('button', { class: 'btn secondary', type: 'button', onClick: () => open(me) }, icon('bookmark'), 'Saved messages')));
  }

  function renderPane() {
    recorder?.cancel(); recorder = null;
    if (!active) { pane.replaceChildren(placeholderPane()); log = textarea = null; return; }
    const id = active, kind = kindOf(id);
    const g = isGroup(id) ? grp(id) : undefined, pc = isPub(id) ? pubCh(id) : undefined, chan = isChannel(id), dm = kind === 'dm';
    textarea = h('textarea', { class: 'composer-input', id: 'compose', rows: '1', placeholder: 'Write a message', 'aria-label': 'Message', maxlength: String(DEFAULT_LIMITS.maxMessageChars * 2) });
    textarea.value = client.x.draft(id);
    counter = h('div', { class: 'count', 'aria-live': 'polite' });
    replyBox = h('div', { class: 'replying', hidden: true });
    sendBtn = h('button', { class: 'send-btn', type: 'button', 'aria-label': 'Send message', onClick: () => void primaryAction() }, icon('send'));
    textarea.addEventListener('input', () => { grow(); updateCount(); syncSendButton(); if (dm) client.profile.typing(id); });
    textarea.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); } if (e.key === 'Escape' && (editing || replyTo)) { editing = null; replyTo = null; renderReply(); } });
    textarea.addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files ?? [])]; if (fs.length && !isPub(id)) { e.preventDefault(); void sendFiles(client, id, fs); } });
    log = h('div', { class: 'log', role: 'log', 'aria-label': `Conversation with ${label(id)}`, 'aria-live': 'polite', tabindex: '0', onScroll: updateToBottom });
    toBottom = h('button', { class: 'to-bottom', type: 'button', 'aria-label': 'Scroll to newest message', hidden: true, onClick: () => log!.scrollTo({ top: log!.scrollHeight, behavior: 'smooth' }) }, icon('down'));
    pinBox = h('div', { class: 'pinned', hidden: true });
    subEl = h('div', { class: 'status-line' }, chatSub(id));
    const info = () => { if (pc) channelInfo(id); else if (g) groupInfo(id); else if (dm) void verify(id); };
    const canPost = !chan || amAdmin(id);
    const attachInput = h('input', { type: 'file', multiple: true, class: 'sr-only', id: 'attach-input', tabindex: '-1', 'aria-hidden': 'true', onChange: () => { const fs = [...((attachInput as HTMLInputElement).files ?? [])]; (attachInput as HTMLInputElement).value = ''; if (fs.length) void sendFiles(client, id, fs, { caption: textarea?.value.trim() || undefined, replyTo: replyTo?.id }).then(() => { if (textarea) { textarea.value = ''; client.x.setDraft(id, ''); } replyTo = null; renderReply(); syncSendButton(); }); } });
    const ttl = client.x.ttlOf(id);
    const composerEl: Node = dm && client.blockedSet.has(id)
      ? h('div', { class: 'composer notice-bar' }, 'You blocked this person. Unblock to write to them.')
      : g?.removed ? h('div', { class: 'composer notice-bar' }, 'You are no longer in this group. You can still read the history on this device.')
      : !canPost ? h('div', { class: 'composer notice-bar' }, pc && !pc.role
          ? h('button', { class: 'btn block', type: 'button', onClick: async () => { try { await client.ch.subscribe(pc.id); renderPane(); renderList(); } catch (e) { toast((e as any)?.status === 409 ? 'You are in too many groups and channels.' : 'Could not subscribe.'); } } }, 'Subscribe')
          : 'Only admins can post in this channel.')
      : h('div', { class: 'composer' }, replyBox,
          ttl ? h('button', { class: 'ttl-chip', type: 'button', onClick: () => ttlDialog(id) }, icon('timer'), `Messages disappear after ${ttl < 3600 ? `${ttl}s` : ttl < 86400 ? `${ttl / 3600} h` : ttl === 86400 ? '1 day' : '1 week'}`) : null,
          composerRow = h('div', { class: 'composer-row' },
            isPub(id) ? null : iconBtn('paperclip', 'Attach a file', (e) => showMenu(e.currentTarget as HTMLElement, [{ label: 'Photo or video', icon: 'image', onClick: () => { attachInput.setAttribute('accept', 'image/*,video/*'); attachInput.click(); } }, { label: 'File', icon: 'file', onClick: () => { attachInput.removeAttribute('accept'); attachInput.click(); } }]), 'icon-btn attach'),
            h('div', { class: 'input-wrap' }, textarea), sendBtn), counter, attachInput);
    const moreBtn = iconBtn('more', 'More', (e) => chatMenu(id, e.currentTarget as HTMLElement), 'icon-btn');
    pane.replaceChildren(
      h('header', { class: 'pane-head' },
        iconBtn('back', 'Back to chats', closeChat, 'icon-btn back'),
        h('button', { class: 'head-main', type: 'button', onClick: info, 'aria-label': `${label(id)}, open details` }, avatarFor(id, 'avatar sm'), h('span', { class: 'grow' }, h('span', { class: 'name' }, label(id)), subEl)),
        dm && client.calls.supported ? iconBtn('phone', 'Start a voice call', () => { void placeCall(id); }) : null,
        iconBtn('search', 'Search in this chat', () => chatSearch(id)), moreBtn),
      pinBox, h('div', { class: 'log-wrap' }, log, toBottom, h('div', { class: 'drop-hint', hidden: true }, icon('download'), 'Drop files to send')), composerEl);
    const wrap = pane.querySelector<HTMLElement>('.log-wrap')!;
    const hint = wrap.querySelector<HTMLElement>('.drop-hint')!;
    if (!isPub(id)) {
      wrap.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); hint.hidden = false; } });
      wrap.addEventListener('dragleave', (e) => { if (e.target === hint || e.target === wrap) hint.hidden = true; });
      wrap.addEventListener('drop', (e) => { e.preventDefault(); hint.hidden = true; const fs = [...(e.dataTransfer?.files ?? [])]; if (fs.length && canPost) void sendFiles(client, id, fs); });
    }
    paneSig = sigOf(id);
    renderMessages(true); grow(); updateCount(); renderReply(); renderPin(); syncSendButton();
  }

  function syncSendButton() {
    if (!sendBtn || !textarea) return;
    const has = !!textarea.value.trim() || !!editing;
    const wantMic = !has && !!active && !isPub(active) && typeof MediaRecorder !== 'undefined';
    sendBtn.replaceChildren(icon(wantMic ? 'mic' : 'send'));
    sendBtn.setAttribute('aria-label', wantMic ? 'Record a voice message' : editing ? 'Save edit' : 'Send message');
    sendBtn.classList.toggle('mic', wantMic);
  }
  async function primaryAction() { if (!textarea) return; if (!textarea.value.trim() && !editing && active && !isPub(active) && typeof MediaRecorder !== 'undefined') await startRecording(); else await send(); }

  async function startRecording() {
    if (!active || !composerRow || recorder) return;
    const rec = new Recorder();
    try { await rec.start(); } catch (e) { toast((e as Error).name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in the address bar.' : 'Could not start recording.'); return; }
    recorder = rec;
    const chat = active, bars = h('div', { class: 'rec-bars', 'aria-hidden': 'true' }), timer = h('span', { class: 'rec-time' }, '0:00');
    rec.level = (v) => { bars.append(h('i', { class: 'rec-bar' })); (bars.lastElementChild as HTMLElement).style.setProperty('--v', String(Math.max(0.12, v))); while (bars.childElementCount > 40) bars.firstElementChild!.remove(); };
    const tick = window.setInterval(() => { timer.textContent = fmtDur(rec.seconds); if (rec.seconds > 600) void finish(); }, 250);
    const stopUi = () => { clearInterval(tick); recorder = null; bar.remove(); composerRow!.hidden = false; };
    const finish = async () => { if (recorder !== rec) return; try { const r = await rec.finish(); stopUi(); if (r.duration < 1) return; await sendFiles(client, chat, [r.file], { voice: { duration: r.duration, wave: r.wave } }); } catch { stopUi(); toast('Could not save the recording.'); } };
    const bar = h('div', { class: 'recording', role: 'status', 'aria-label': 'Recording a voice message' },
      iconBtn('trash', 'Discard recording', () => { rec.cancel(); stopUi(); }, 'icon-btn'), h('span', { class: 'rec-dot' }), timer, bars,
      h('button', { class: 'send-btn', type: 'button', 'aria-label': 'Send voice message', onClick: () => void finish() }, icon('send')));
    composerRow.hidden = true; composerRow.after(bar);
  }

  async function blockDialog(id: string) {
    const blocked = client.blockedSet.has(id);
    const yes = await confirmModal(blocked ? 'Unblock this person?' : 'Block this person?', blocked ? 'They will be able to write to you and call you again.' : `${person(id)} will not be able to reach you. Messages they send look delivered to them but never arrive, and they are not told.`, blocked ? 'Unblock' : 'Block', !blocked);
    if (!yes) return;
    try { if (blocked) await client.profile.unblock(id); else await client.profile.block(id); renderPane(); renderList(); } catch { toast('Could not change the block.'); }
  }

  function renderPin() {
    if (!pinBox || !active || !(isGroup(active) || isPub(active))) return;
    const pinned = isPub(active) ? pubCh(active)?.pinnedPost : grp(active)?.pinned, m = pinned ? (client.chats.get(active) ?? []).find((x) => x.id === pinned) : undefined;
    pinBox.hidden = !m;
    pinBox.replaceChildren(...kids(...(m ? [h('button', { class: 'pin-main', type: 'button', onClick: () => scrollToMessage(m.id) }, icon('pin'), h('span', { class: 'grow' }, h('span', { class: 'pin-title' }, 'Pinned message'), h('span', { class: 'preview' }, m.file ? fileLabel(m.file) : m.body))),
      amAdmin(active) ? iconBtn('x', 'Unpin message', () => { void (isPub(active!) ? client.ch.pin(gid(active!), null) : client.gm.pin(gid(active!), null)).catch(() => toast('Could not unpin.')); }, 'icon-btn tiny') : null] : [])));
  }

  function grow() { if (!textarea) return; textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`; }
  function updateCount() {
    if (!textarea || !counter) return;
    const n = [...textarea.value].length, max = DEFAULT_LIMITS.maxMessageChars;
    counter.textContent = n > max - 500 ? `${n} / ${max}` : ''; counter.classList.toggle('over', n > max);
  }
  function updateToBottom() { if (log && toBottom) toBottom.hidden = log.scrollHeight - log.scrollTop - log.clientHeight < 160; }
  function renderReply() {
    if (!replyBox) return;
    const target = editing ?? replyTo;
    replyBox.hidden = !target;
    replyBox.replaceChildren(...(target ? [icon(editing ? 'edit' : 'reply'), h('div', { class: 'grow' }, h('div', { class: 'reply-title' }, editing ? 'Editing message' : `Reply to ${person(target.from)}`), h('div', { class: 'preview' }, target.file ? fileLabel(target.file) : target.body)),
      iconBtn('x', 'Cancel', () => { editing = null; replyTo = null; if (textarea && editing === null) { /* keep what was typed */ } renderReply(); syncSendButton(); }, 'icon-btn tiny')] : []));
    syncSendButton();
  }

  // ---------- messages ----------
  onUploadsChange(() => { if (active) renderMessages(); });

  function messageMenu(m: ChatMessage, at: HTMLElement | { x: number; y: number }) {
    const chat = active!;
    const mine = m.from === me && !isChannel(chat);
    const editable = !m.sys && mine && !isPub(chat);
    const canReact = !isPub(chat) && !grp(chat)?.removed;
    {
      showMenu(at, [
        !isChannel(chat) && !grp(chat)?.removed && !isPub(chat) ? { label: 'Reply', icon: 'reply', onClick: () => { replyTo = m; editing = null; renderReply(); textarea?.focus(); } } : null,
        editable ? { label: 'Edit', icon: 'edit', onClick: () => { editing = m; replyTo = null; if (textarea) { textarea.value = m.body; grow(); } renderReply(); textarea?.focus(); } } : null,
        isPub(chat) && amAdmin(chat) ? { label: 'Edit post', icon: 'edit', onClick: () => editPost(chat, m) } : null,
        m.body ? { label: 'Copy text', icon: 'copy', onClick: () => void copyText(m.body) } : null,
        !isPub(chat) ? { label: 'Forward', icon: 'forward', onClick: () => forwardDialog(m) } : null,
        (isGroup(chat) || isPub(chat)) && amAdmin(chat) && !grp(chat)?.removed ? { label: 'Pin', icon: 'pin', onClick: () => { void (isPub(chat) ? client.ch.pin(gid(chat), m.id) : client.gm.pin(gid(chat), m.id)).catch(() => toast('Could not pin.')); } } : null,
        !mine && !isPub(chat) && kindOf(chat) !== 'saved' ? { label: 'Report sender', icon: 'block', danger: true, onClick: () => reportDialog(client, m.from, person(m.from), [m]) } : null,
        'sep', { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteDialog(chat, m) },
      ], canReact ? { current: m.reactions?.[me], onPick: (e) => void client.x.react(chat, m.id, e).catch(() => toast('Could not react.')) } : undefined);
    }
  }

  function bubbleSig(m: ChatMessage, first: boolean, last: boolean, id: string): string {
    return [m.body, m.edited, m.read, m.delivered, JSON.stringify(m.reactions ?? {}), m.views, first, last, m.exp, m.fwd, m.replyTo, person(m.from), m.file?.fileId].join('|') + (isPub(id) ? '' : '');
  }

  function buildBubble(id: string, m: ChatMessage, first: boolean, last: boolean, byId: Map<string, ChatMessage>): HTMLElement {
    const post = isChannel(id), mine = m.from === me && !post, group = isGroup(id) && !post;
    const q = m.replyTo ? byId.get(m.replyTo) : undefined;
    const reactions = Object.entries(m.reactions ?? {}).reduce<Record<string, string[]>>((acc, [who, e]) => { (acc[e] ??= []).push(who); return acc; }, {});
    const meta = h('span', { class: 'meta' }, m.edited ? 'edited ' : '', m.exp ? h('span', { class: 'mini' }, icon('timer')) : null, timeFmt.format(m.ts), tickFor(m, id));
    const media = m.file ? attachmentNode(client, m, () => renderMessages()) : null;
    const mediaOnly = !!m.file && (m.file.kind === 'image' || m.file.kind === 'video') && !m.body && !m.fwd && !q;
    const body = h('div', { class: `bubble ${mediaOnly ? 'media-only' : ''}` },
      group && !mine && first ? h('div', { class: `author ${colorClass(m.from).replace('av-', 'au-')}` }, person(m.from)) : null,
      m.fwd ? h('div', { class: 'fwd' }, icon('forward'), `Forwarded from ${m.fwd}`) : null,
      q ? h('button', { class: 'quote', type: 'button', onClick: () => scrollToMessage(q.id) }, h('span', { class: 'quote-author' }, person(q.from)), h('span', { class: 'quote-text' }, q.file ? fileLabel(q.file) : q.body)) : m.replyTo ? h('div', { class: 'quote gone' }, 'Deleted message') : null,
      media, m.body ? h('span', { class: 'text' }, m.body) : null,
      h('span', { class: 'meta-spacer', 'aria-hidden': 'true' }, `${m.edited ? 'edited ' : ''}${m.exp ? '  ' : ''}${timeFmt.format(m.ts)}${tickFor(m, id) ? '    ' : ''}`), meta,
      iconBtn('more', 'Message options', (e) => { e.stopPropagation(); messageMenu(m, e.currentTarget as HTMLElement); }, 'bubble-more'));
    const pills = Object.entries(reactions).length ? h('div', { class: 'reactions' }, Object.entries(reactions).map(([e, who]) => h('button', { class: `pill ${who.includes(me) ? 'mine' : ''}`, type: 'button', 'aria-label': `${e} ${who.length}, ${who.includes(me) ? 'remove your reaction' : 'react'}`, onClick: () => void client.x.react(id, m.id, who.includes(me) ? null : e).catch(() => toast('Could not react.')) }, e, who.length > 1 ? h('span', { class: 'count' }, String(who.length)) : null))) : null;
    const row = h('div', { class: `bubble-row ${mine ? 'mine' : 'theirs'} ${first ? 'first' : ''} ${last ? 'last' : ''} ${post ? 'post' : ''} ${group && !mine ? 'with-avatar' : ''}`, 'data-mid': m.id, 'data-post': isPub(id) ? m.id : null },
      h('div', { class: 'bubble-col' },
        h('div', { class: 'bubble-line' }, group && !mine ? (last ? avatarFor(m.from, 'avatar xs') : h('span', { class: 'avatar-gap' })) : null, body),
        pills, isPub(id) ? h('div', { class: 'views', 'aria-label': `${m.views ?? 0} views` }, icon('eye'), String(m.views ?? 0)) : null));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); messageMenu(m, { x: e.clientX, y: e.clientY }); });
    let t = 0; row.addEventListener('touchstart', (e) => { const p = e.touches[0]!; t = window.setTimeout(() => messageMenu(m, { x: p.clientX, y: p.clientY }), 450); }, { passive: true });
    for (const ev of ['touchend', 'touchmove', 'touchcancel'] as const) row.addEventListener(ev, () => clearTimeout(t), { passive: true });
    row.addEventListener('dblclick', () => { if (!isPub(id) && !grp(id)?.removed) void client.x.react(id, m.id, m.reactions?.[me] === '❤️' ? null : '❤️').catch(() => {}); });
    return row;
  }

  function renderMessages(forceBottom = false) {
    if (!log || !active) return;
    const id = active, atBottom = forceBottom || log.scrollHeight - log.scrollTop - log.clientHeight < 160;
    const msgs = sorted(id), byId = new Map(msgs.map((m) => [m.id, m]));
    const nodes: Node[] = []; let day = '';
    if (!msgs.length && ![...uploads.values()].some((u) => u.chat === id)) nodes.push(h('div', { class: 'chat-empty' }, h('div', { class: 'hero-art small', 'aria-hidden': 'true' }, h('span', { class: 'b1' }), h('span', { class: 'b2' }), icon('chat')), h('p', {}, isSaved(id) ? 'Save notes, links and files here. They sync between your devices, end-to-end encrypted.' : `No messages yet. Say hello to ${label(id)}.`)));
    const live = new Set<string>();
    msgs.forEach((m, i) => {
      const d = dayFmt.format(m.ts);
      if (d !== day) { day = d; nodes.push(h('div', { class: 'day' }, h('span', {}, isToday(m.ts) ? 'Today' : d))); }
      if (m.sys) { nodes.push(h('div', { class: 'sysnote' }, icon(/call|Voice/i.test(m.body) ? 'phone' : 'timer'), m.body)); return; }
      const prev = msgs[i - 1], next = msgs[i + 1];
      const joins = (a?: ChatMessage, b?: ChatMessage) => !!a && !!b && !a.sys && !b.sys && a.from === b.from && Math.abs(b.ts - a.ts) < GROUP_GAP && dayFmt.format(a.ts) === dayFmt.format(b.ts);
      const first = !joins(prev, m), last = !joins(m, next);
      const sig = bubbleSig(m, first, last, id);
      let c = msgCache.get(m.id);
      if (!c || c.sig !== sig) { const el = buildBubble(id, m, first, last, byId); if (!forceBottom && !seenIds.has(m.id)) el.classList.add('enter'); c = { sig, el }; msgCache.set(m.id, c); }
      seenIds.add(m.id); live.add(m.id);
      nodes.push(c.el);
    });
    for (const k of [...msgCache.keys()]) if (!live.has(k)) msgCache.delete(k);
    for (const u of uploads.values()) if (u.chat === id) nodes.push(uploadNode(u, () => { uploads.delete(u.id); renderMessages(); }));
    const cur = log.children; let same = cur.length === nodes.length;
    for (let i = 0; same && i < nodes.length; i++) if (cur[i] !== nodes[i]) same = false;
    if (!same) log.replaceChildren(...nodes); // an unchanged list costs no layout at all
    if (isPub(id)) observeViews(id);
    if (atBottom) log.scrollTo({ top: log.scrollHeight });
    updateToBottom();
  }

  async function send() {
    if (!active || !textarea || !sendBtn) return;
    const text = textarea.value.trim();
    if (!text && !editing) return;
    if ([...text].length > DEFAULT_LIMITS.maxMessageChars) return toast(`Messages are limited to ${DEFAULT_LIMITS.maxMessageChars} characters.`);
    sendBtn.disabled = true;
    const chat = active;
    try {
      if (editing) { const m = editing; editing = null; await client.x.edit(chat, m.id, text); }
      else if (isPub(chat)) await client.ch.post(gid(chat), text);
      else if (isGroup(chat)) await client.gm.sendText(gid(chat), text, replyTo?.id);
      else await client.sendText(chat, text, replyTo?.id);
      textarea.value = ''; client.x.setDraft(chat, ''); replyTo = null; renderReply(); grow(); updateCount(); syncSendButton();
      renderMessages(true);
    } catch (e) { toast((e as any)?.status === 429 ? 'You are sending too fast. Wait a moment.' : (e as Error).message?.includes('your own') ? 'You can only edit your own messages.' : (e as Error).message === 'account restricted' ? 'Your account is temporarily limited. You can still answer people who wrote to you.' : (e as Error).message === 'rate limited' ? 'You are starting too many new chats. Wait a bit.' : 'Could not send. Check your connection.'); }
    finally { sendBtn.disabled = false; textarea.focus(); }
  }

  function deleteDialog(peer: string, m: ChatMessage) {
    if (isPub(peer)) {
      void confirmModal('Delete this post?', 'It is removed for every subscriber. Screenshots and copies cannot be removed.', 'Delete post').then(async (yes) => {
        if (yes) { try { await client.ch.remove(gid(peer), m.id); toast('Post deleted'); } catch { toast('Deleting failed. Try again.'); } }
      });
      return;
    }
    const group = isGroup(peer);
    const mine = (m.from === me && !isChannel(peer) && !isSaved(peer)) || (group && amAdmin(peer) && !grp(peer)?.removed); // group admins can delete anyone's message
    const run = (fn: () => Promise<void>, done: string) => async () => { dlg.close(); try { await fn(); toast(done); } catch { toast('Deleting failed. Try again.'); } };
    const everyone = () => group ? client.gm.deleteForEveryone(gid(peer), m.id) : client.deleteForEveryone(peer, m.id);
    const dlg = modal('Delete message', [
      h('p', { class: 'muted' }, mine
        ? 'Delete for everyone removes it from all chats. It cannot remove screenshots or copies saved outside Vanishgram.'
        : 'Delete for me removes it only from your devices. Only the sender can delete it for everyone.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn secondary', type: 'button', onClick: run(() => client.deleteForMe(peer, m.id), 'Deleted for you') }, 'Delete for me'),
        mine ? h('button', { class: 'btn danger', type: 'button', onClick: run(everyone, 'Deleted for everyone') }, 'Delete for everyone') : null,
        h('button', { class: 'btn secondary', type: 'button', onClick: () => dlg.close() }, 'Cancel')),
    ]);
  }

  function forwardDialog(m: ChatMessage) {
    const q = h('input', { class: 'input', id: 'fwd-q', placeholder: 'Search chats', autocomplete: 'off', 'aria-label': 'Search chats' });
    const box = h('ul', { class: 'pick-list' });
    const canSendTo = (id: string) => !isPub(id) && !(isChannel(id) && !amAdmin(id)) && !grp(id)?.removed && !(kindOf(id) === 'dm' && client.blockedSet.has(id));
    const draw = () => {
      const needle = q.value.toLowerCase();
      const ids = [...new Set([me, ...allChatIds()])].filter((id) => canSendTo(id) && label(id).toLowerCase().includes(needle));
      box.replaceChildren(...ids.slice(0, 60).map((id) => h('li', {}, h('button', { class: 'chat-item', type: 'button', onClick: async () => {
        d.close();
        try { await client.x.forward(id, m, person(m.from)); toast(`Forwarded to ${label(id)}`); if (id !== active) open(id); } catch { toast('Could not forward.'); }
      } }, h('span', { class: 'avatar-wrap' }, avatarFor(id, 'avatar')), h('span', { class: 'meta' }, h('span', { class: 'name' }, label(id)), h('span', { class: 'preview' }, kindOf(id) === 'saved' ? 'Notes to yourself' : kindOf(id) === 'dm' ? 'Chat' : kindOf(id) === 'group' ? 'Group' : 'Channel'))))));
    };
    q.addEventListener('input', draw);
    const d = modal('Forward to', [q, box, h('button', { class: 'btn secondary block mt14', type: 'button', onClick: () => d.close() }, 'Cancel')]); draw();
  }

  function ttlDialog(chat: string) {
    const cur = client.x.ttlOf(chat);
    const text = (s: number) => s === 0 ? 'Off' : s === 30 ? '30 seconds' : s === 3600 ? '1 hour' : s === 86400 ? '1 day' : '1 week';
    const d = modal('Disappearing messages', [h('p', { class: 'muted' }, 'New messages in this chat are removed from both devices after the time you choose. Screenshots and copies made outside Vanishgram cannot be removed.'),
      h('div', { class: 'choices' }, TTL_CHOICES.map((s) => h('button', { class: `choice ${s === cur ? 'on' : ''}`, type: 'button', onClick: async () => { d.close(); try { await client.x.setTtl(chat, s); renderPane(); } catch (e) { toast((e as Error).message.includes('admins') ? 'Only admins can change this.' : 'Could not change the timer.'); } } }, text(s), s === cur ? icon('check') : null))),
      h('button', { class: 'btn secondary block mt14', type: 'button', onClick: () => d.close() }, 'Close')]);
  }

  function foldersDialog(chat?: string) {
    const body = h('div', {});
    const draw = () => {
      const fs = client.prefs.folders;
      const nameIn = h('input', { class: 'input', id: 'folder-new', maxlength: '24', placeholder: 'New folder name', autocomplete: 'off' });
      body.replaceChildren(
        fs.length ? h('ul', { class: 'pick-list' }, fs.map((f) => h('li', { class: 'folder-row' },
          chat ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.chats.includes(chat), onChange: (e: Event) => void client.x.setInFolder(f.id, chat, (e.target as HTMLInputElement).checked) }), h('span', {}, f.name))
            : h('span', { class: 'grow name' }, f.name, h('span', { class: 'muted small' }, `  ${plural(f.chats.length, 'chat')}`)),
          chat ? null : h('button', { class: 'btn secondary small-btn', type: 'button', onClick: async () => { const n = prompt('Rename folder', f.name); if (n) { await client.x.renameFolder(f.id, n); draw(); } } }, 'Rename'),
          chat ? null : h('button', { class: 'btn secondary small-btn', type: 'button', onClick: async () => { await client.x.deleteFolder(f.id); draw(); } }, 'Delete')))) : h('p', { class: 'muted' }, 'Folders group chats into tabs above your chat list. Create one to get started.'),
        h('form', { class: 'row mt14', onSubmit: async (e: Event) => { e.preventDefault(); try { const id = await client.x.createFolder(nameIn.value); if (chat) await client.x.setInFolder(id, chat, true); draw(); renderList(); } catch (er) { toast((er as Error).message); } } }, nameIn, h('button', { class: 'btn', type: 'submit' }, 'Create')));
    };
    draw();
    const d = modal(chat ? 'Add to folder' : 'Chat folders', [body, h('button', { class: 'btn secondary block mt14', type: 'button', onClick: () => { d.close(); renderList(); } }, 'Done')], { onClose: () => renderList() });
  }

  function chatMenu(id: string, at: HTMLElement | { x: number; y: number }) {
    const kind = kindOf(id), muted = client.muted.has(id), pinned = client.x.isPinned(id), archived = client.x.isArchived(id);
    const run = (p: Promise<unknown>) => { void p.then(() => { renderList(); if (active === id) renderPane(); }).catch((e) => toast((e as Error).message || 'Could not do that.')); };
    const g = isGroup(id) ? grp(id) : undefined;
    showMenu(at, [
      id === active ? { label: 'Search in chat', icon: 'search', onClick: () => chatSearch(id) } : null,
      { label: pinned ? 'Unpin chat' : 'Pin chat', icon: 'pin', onClick: () => run(client.x.pinChat(id, !pinned)) },
      { label: muted ? 'Unmute' : 'Mute', icon: muted ? 'bell' : 'bellOff', onClick: () => run(client.x.setMuted(id, !muted)) },
      { label: archived ? 'Unarchive' : 'Archive', icon: 'archive', onClick: () => run(client.x.archiveChat(id, !archived)) },
      { label: 'Add to folder', icon: 'folder', onClick: () => foldersDialog(id) },
      !isPub(id) && kind !== 'saved' && !(isChannel(id) && !amAdmin(id)) ? { label: 'Disappearing messages', icon: 'timer', onClick: () => ttlDialog(id) } : null,
      kind === 'dm' ? 'sep' : null,
      kind === 'dm' ? { label: 'Verify encryption', icon: 'lock', onClick: () => void verify(id) } : null,
      kind === 'dm' ? { label: client.blockedSet.has(id) ? 'Unblock' : 'Block', icon: 'block', danger: !client.blockedSet.has(id), onClick: () => void blockDialog(id) } : null,
      kind === 'dm' ? { label: 'Report', icon: 'block', danger: true, onClick: () => reportDialog(client, id, person(id), sorted(id).filter((x) => x.from === id)) } : null,
      g || isPub(id) ? 'sep' : null,
      isPub(id) ? { label: 'Channel info', icon: 'users', onClick: () => channelInfo(id) } : g ? { label: g.kind === 'channel' ? 'Channel info' : 'Group info', icon: 'users', onClick: () => groupInfo(id) } : null,
    ]);
  }

  function chatSearch(id: string) {
    if (active !== id) open(id);
    pane.querySelector('.chat-search')?.remove();
    const input = h('input', { class: 'search-input', id: 'in-chat-search', type: 'search', placeholder: 'Search in this chat', autocomplete: 'off', 'aria-label': 'Search in this chat' });
    const status = h('span', { class: 'muted small' }, '');
    let hits: ChatMessage[] = [], i = 0;
    const go = (d: number) => { if (!hits.length) return; i = (i + d + hits.length) % hits.length; status.textContent = `${i + 1} of ${hits.length}`; scrollToMessage(hits[i]!.id); };
    input.addEventListener('input', () => { hits = client.x.search(input.value, { chat: id, limit: 200 }).map((x) => x.message).sort((a, b) => b.ts - a.ts); i = -1; status.textContent = input.value.length < 2 ? '' : hits.length ? `${hits.length} found` : 'No matches'; if (hits.length) go(1); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(e.shiftKey ? -1 : 1); if (e.key === 'Escape') bar.remove(); });
    const bar = h('div', { class: 'chat-search' }, icon('search'), input, status, iconBtn('down', 'Previous match', () => go(1), 'icon-btn tiny'), iconBtn('x', 'Close search', () => bar.remove(), 'icon-btn tiny'));
    pane.querySelector('.pane-head')!.after(bar); input.focus();
  }

  async function verify(peer: string) {
    if (isSaved(peer)) return;
    try {
      const { devices } = await client.http<{ devices: PrekeyBundleWire[] }>('GET', `/v1/accounts/${peer}/devices`);
      if (!devices.length) throw new Error('none');
      await verifyBundle(devices[0]!, peer, client.device.signal);
      const sn = safetyNumber(client.account.authPublicKey, unb64(devices[0]!.authPublicKey));
      modal('Verify encryption', [
        h('p', { class: 'muted' }, `Compare this number with ${label(peer)} in person or over a call. If it matches on both sides, no one is intercepting your chat.`),
        h('p', { class: 'kv' }, h('code', { 'aria-label': 'Safety number' }, sn)),
        h('div', { class: 'actions' }, h('button', { class: 'btn secondary', type: 'button', onClick: () => copyText(sn) }, 'Copy number')),
      ]);
    } catch { toast('Could not load the safety number.'); }
  }

  // ---------- voice calls ----------
  client.calls.factory = callsSupported() ? createWebPeerFactory() : null;
  let callBox: HTMLElement | null = null;
  let ringCtx: AudioContext | null = null;
  let ringTimer = 0;
  let tick = 0;
  let endedTimer = 0;
  const fmt = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const reasonText: Record<string, string> = { declined: 'Call declined', busy: 'Line busy', cancelled: 'Call cancelled', 'no-answer': 'No answer', hangup: 'Call ended', missed: 'Missed call', unknown: 'This person cannot take your call yet', 'connection-failed': 'Connection failed', 'connection-lost': 'Connection lost', error: 'Call failed' };

  function stopRing() { clearInterval(ringTimer); ringTimer = 0; void ringCtx?.close().catch(() => {}); ringCtx = null; }
  function startRing() {
    if (ringTimer) return;
    const beep = () => {
      try {
        ringCtx ??= new AudioContext();
        const o = ringCtx.createOscillator(), g = ringCtx.createGain();
        o.frequency.value = 440; g.gain.value = 0.08; o.connect(g); g.connect(ringCtx.destination);
        o.start(); o.stop(ringCtx.currentTime + 0.7);
      } catch { /* autoplay blocked: the visual prompt is still there */ }
    };
    beep(); ringTimer = window.setInterval(beep, 2500);
  }

  async function placeCall(peer: string) {
    try { await client.calls.start(peer, { relayOnly: localStorage.getItem('vg.relay') === '1' }); }
    catch (e) {
      const n = (e as Error).name;
      toast(n === 'NotAllowedError' || n === 'SecurityError' ? 'Microphone access was denied. Allow it in the address bar and try again.' : n === 'NotFoundError' ? 'No microphone found.' : (e as Error).message === 'already in a call' ? 'You are already in a call.' : 'Could not start the call.');
    }
  }

  function renderCall(s: CallState | null) {
    clearInterval(tick); tick = 0;
    if (!s) { stopRing(); if (document.title === 'Incoming call') document.title = 'Vanishgram'; return; } // the ended box removes itself
    callBox?.remove();
    if (s.status === 'ended' && (s.reason === 'handled-elsewhere' || s.reason === 'answered-elsewhere')) { stopRing(); return; }
    const name = label(s.peer);
    const status = h('div', { class: 'call-status', role: 'status', 'aria-live': 'polite' });
    const setStatus = () => {
      status.textContent = s.status === 'calling' ? 'Calling' : s.status === 'incoming' ? 'Incoming voice call' : s.status === 'connecting' ? 'Connecting' : s.status === 'connected' ? `Connected ${fmt(Date.now() - (s.startedAt ?? Date.now()))}` : (reasonText[s.reason ?? ''] ?? 'Call ended');
    };
    setStatus();
    if (s.status === 'connected') tick = window.setInterval(setStatus, 1000);
    if (s.status === 'incoming') { startRing(); document.title = 'Incoming call'; } else { stopRing(); if (document.title === 'Incoming call') document.title = 'Vanishgram'; }

    const actions: Node[] = [];
    if (s.status === 'incoming') {
      actions.push(
        h('button', { class: 'btn', id: 'call-accept', type: 'button', onClick: async () => { try { await client.calls.accept(); } catch (e) { toast((e as Error).name === 'NotAllowedError' ? 'Microphone access was denied.' : 'Could not answer the call.'); } } }, icon('phone'), ' Answer'),
        h('button', { class: 'btn danger', type: 'button', onClick: () => client.calls.decline() }, 'Decline'));
    } else if (s.status !== 'ended') {
      const mute = h('button', { class: 'btn secondary', type: 'button', 'aria-pressed': String(s.muted), onClick: () => client.calls.setMuted(!client.calls.state?.muted) }, icon(s.muted ? 'micOff' : 'mic'), s.muted ? ' Unmute' : ' Mute');
      actions.push(mute, h('button', { class: 'btn danger', type: 'button', onClick: () => client.calls.hangup() }, 'End call'));
    }
    const extras: Node[] = [];
    if (s.sas && s.status !== 'ended') extras.push(h('div', { class: 'call-code' }, h('div', { class: 'muted small' }, 'Call code'), h('code', { 'aria-label': 'Call code' }, s.sas),
      h('div', { class: 'muted small' }, 'Read this aloud. If you both see the same numbers, nobody is listening in.')));
    if (s.status === 'connected' || s.status === 'connecting') {
      if (speakerSelectionSupported) {
        const sel = h('select', { class: 'input', id: 'speaker', 'aria-label': 'Speaker' });
        void listAudioDevices().then(({ speakers }) => {
          if (!speakers.length) return;
          sel.replaceChildren(...speakers.map((d, i) => h('option', { value: d.deviceId }, d.label || `Speaker ${i + 1}`)));
          sel.value = currentSpeaker() ?? speakers[0]!.deviceId;
        });
        sel.addEventListener('change', () => void setSpeaker(sel.value));
        extras.push(h('div', { class: 'field' }, h('label', { for: 'speaker' }, 'Speaker'), sel));
      }
      extras.push(h('p', { class: 'muted small' }, s.relayOnly ? 'Relayed through a server: the other person cannot see your IP address. The audio is still end-to-end encrypted.' : 'Direct connection: the other person can see your IP address. The audio is end-to-end encrypted.'));
    }
    callBox = h('div', { class: 'callbox', role: s.status === 'incoming' ? 'alertdialog' : 'dialog', 'aria-label': 'Voice call with ' + name },
      avatarEl(client, s.peer, 'avatar lg alt'), h('div', { class: 'name' }, name), status, ...extras, h('div', { class: 'row wrap callbtns' }, ...actions));
    document.body.append(callBox);
    if (s.status === 'incoming') (callBox.querySelector('#call-accept') as HTMLElement | null)?.focus();
    if (s.status === 'ended') { clearTimeout(endedTimer); endedTimer = window.setTimeout(() => { if (!client.calls.state) callBox?.remove(); }, 2500); }
  }
  client.onCall = renderCall;

  // ---------- channels ----------
  let viewObserver: IntersectionObserver | null = null;
  function observeViews(chat: string) {
    viewObserver?.disconnect();
    if (!log || typeof IntersectionObserver === 'undefined') return;
    viewObserver = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting && !document.hidden) { const pid = (e.target as HTMLElement).dataset.post; if (pid) client.ch.markViewed(gid(chat), pid); }
    }, { root: log, threshold: 0.6 });
    log.querySelectorAll('[data-post]').forEach((el) => viewObserver!.observe(el));
  }

  function editPost(chat: string, m: ChatMessage) {
    const ta = h('textarea', { class: 'input', id: 'editpost', rows: '4', maxlength: String(DEFAULT_LIMITS.maxMessageChars) });
    ta.value = m.body;
    const dlg = modal('Edit post', [h('div', { class: 'field' }, h('label', { for: 'editpost' }, 'Post text'), ta),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onClick: async () => { try { await client.ch.edit(gid(chat), m.id, ta.value); dlg.close(); } catch { toast('Could not save the post.'); } } }, 'Save'),
        h('button', { class: 'btn secondary', type: 'button', onClick: () => dlg.close() }, 'Cancel'))]);
  }

  function newChannelDialog() {
    let kind: 'public' | 'private' = 'public';
    const title = h('input', { class: 'input', id: 'ctitle', maxlength: '64', autocomplete: 'off', placeholder: 'Channel name' });
    const desc = h('input', { class: 'input', id: 'cdesc', maxlength: '255', autocomplete: 'off', placeholder: 'What is this channel about? (optional)' });
    const uname = h('input', { class: 'input', id: 'cuname', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'channel_username' });
    const unameField = h('div', { class: 'field' }, h('label', { for: 'cuname' }, 'Public link'), uname, h('span', { class: 'muted small' }, 'Anyone can find and read a public channel. Posts are not end-to-end encrypted.'));
    const privHelp = h('p', { class: 'notice', hidden: true }, 'Private channels are end-to-end encrypted. Only people you add or invite can read them, and subscribers cannot see each other.');
    const radio = (value: 'public' | 'private', text: string, checked: boolean) => {
      const input = h('input', { type: 'radio', name: 'ckind', id: `ck-${value}`, checked, onChange: () => { kind = value; unameField.hidden = value === 'private'; privHelp.hidden = value === 'public'; } });
      return h('label', { class: 'check', for: `ck-${value}` }, input, h('span', {}, text));
    };
    const err = h('p', { class: 'msg-error', role: 'alert' });
    const go = h('button', { class: 'btn', type: 'submit' }, 'Create channel');
    const m = modal('New channel', [h('form', { onSubmit: async (e: Event) => {
      e.preventDefault(); err.textContent = '';
      if (!title.value.trim()) return void (err.textContent = 'Enter a channel name.');
      go.disabled = true;
      try {
        if (kind === 'public') { const id = await client.ch.create({ title: title.value, username: uname.value.trim().replace(/^@/, '').toLowerCase(), description: desc.value }); m.close(); open(`c:${id}`); }
        else { const id = await client.gm.createChannel(title.value, desc.value); m.close(); open(`g:${id}`); }
      } catch (e2) {
        const s = (e2 as any)?.status;
        err.textContent = s === 409 ? 'That username is taken.' : s === 403 ? 'That username is reserved.' : s === 400 ? 'Use 3 to 32 characters: lowercase letters, digits, underscore, starting with a letter.' : s === 429 ? 'You created too many channels. Try later.' : 'Could not create the channel.';
        go.disabled = false;
      }
    } },
      radio('public', 'Public: anyone can find it by username', true), radio('private', 'Private: encrypted, by invitation', false),
      h('div', { class: 'field' }, h('label', { for: 'ctitle' }, 'Name'), title),
      h('div', { class: 'field' }, h('label', { for: 'cdesc' }, 'Description'), desc),
      unameField, privHelp, err,
      h('div', { class: 'actions' }, go, h('button', { class: 'btn secondary', type: 'button', onClick: () => m.close() }, 'Cancel')))]);
  }

  function channelInfo(chat: string) {
    const id = gid(chat);
    const body = h('div', {});
    const render = () => {
      const ch = client.channels.get(id);
      if (!ch) return;
      const admin = amAdmin(chat), owner = ch.role === 'owner';
      const act = (fn: () => Promise<unknown>, ok: string) => async () => { try { await fn(); await client.ch.sync(id); toast(ok); render(); } catch (e) { toast((e as Error).message || 'Action failed.'); } };
      const title = h('input', { class: 'input', id: 'chinfo-title', value: ch.title, maxlength: '64', disabled: !admin });
      const desc = h('input', { class: 'input', id: 'chinfo-desc', value: ch.description, maxlength: '255', disabled: !admin });
      const un = h('input', { class: 'input', id: 'chinfo-un', value: ch.username, maxlength: '32', disabled: !owner, autocapitalize: 'off', spellcheck: 'false' });
      const link = `${BASE}/#channel=${ch.username}`;
      const subsBox = h('ul', { class: 'members' });
      body.replaceChildren(...kidsOf(
        h('div', { class: 'field' }, h('label', { for: 'chinfo-title' }, 'Name'), title),
        h('div', { class: 'field' }, h('label', { for: 'chinfo-desc' }, 'Description'), desc),
        h('div', { class: 'field' }, h('label', { for: 'chinfo-un' }, 'Username'), un),
        admin ? h('button', { class: 'btn secondary', type: 'button', onClick: act(() => client.ch.update(id, { title: title.value, description: desc.value, ...(owner && un.value !== ch.username ? { username: un.value.trim().toLowerCase() } : {}) }), 'Saved') }, 'Save') : null,
        h('div', { class: 'section' }, h('h3', {}, plural(ch.subscribers, "subscriber")), h('div', { class: 'kv' }, h('code', {}, link)),
          h('button', { class: 'btn secondary', type: 'button', onClick: () => copyText(link, 'Channel link copied') }, 'Copy link'),
          h('p', { class: 'muted small mt14' }, 'Public channel: posts are readable by anyone and are not end-to-end encrypted. Views count once per account.')),
        admin ? h('div', { class: 'section' }, h('h3', {}, 'Subscribers'), subsBox, h('p', { class: 'muted small' }, 'Only admins can see this list.')) : null,
        ch.role ? h('div', { class: 'section stack' },
          h('button', { class: 'btn secondary', type: 'button', onClick: async () => {
            if (!(await confirmModal('Unsubscribe?', owner ? 'You are the owner. Transfer ownership first, or delete the channel.' : 'You will stop receiving posts.', 'Unsubscribe'))) return;
            try { await client.ch.unsubscribe(id); dlg.close(); closeChat(); } catch (e) { toast((e as any)?.status === 409 ? 'Transfer ownership before leaving.' : 'Could not unsubscribe.'); }
          } }, ch.role === 'owner' || ch.role === 'admin' ? 'Leave channel' : 'Unsubscribe'),
          owner ? h('button', { class: 'btn danger', type: 'button', onClick: async () => {
            if (await confirmModal('Delete channel for everyone?', 'The channel and all its posts are removed permanently.', 'Delete channel')) { try { await client.gm.deleteGroup(id); client.channels.delete(id); client.chats.delete(chat); dlg.close(); closeChat(); } catch { toast('Could not delete the channel.'); } }
          } }, 'Delete channel') : null) : null));
      if (admin) void client.ch.subscribers(id).then(async (subs) => {
        for (const s of subs.slice(0, 30)) await client.resolveContact(s.accountId).catch(() => {});
        subsBox.replaceChildren(...subs.map((s) => {
          const btns: Node[] = [];
          if (s.accountId !== me && s.role !== 'owner') {
            if (owner) btns.push(h('button', { class: 'btn secondary small-btn', type: 'button', onClick: act(() => client.gm.setRole(id, s.accountId, s.role === 'admin' ? 'member' : 'admin'), 'Role updated') }, s.role === 'admin' ? 'Remove admin' : 'Make admin'));
            if (s.role === 'member' || owner) btns.push(h('button', { class: 'btn secondary small-btn', type: 'button', onClick: act(() => client.gm.removeMember(id, s.accountId), 'Subscriber removed') }, 'Remove'));
          }
          return h('li', {}, avatarEl(client, s.accountId, 'avatar alt'), h('span', { class: 'grow' }, h('span', { class: 'name' }, s.accountId === me ? `${person(s.accountId)} (you)` : person(s.accountId)), h('span', { class: 'muted small role' }, s.role)), ...btns);
        }));
      }).catch(() => {});
    };
    const dlg = modal(label(chat), [body, h('button', { class: 'btn secondary block mt14', type: 'button', onClick: () => dlg.close() }, 'Close')], { onClose: () => refreshers.delete(render) });
    render(); refreshers.add(render);
  }

  // ---------- groups ----------

  function newGroupDialog() {
    const name = h('input', { class: 'input', id: 'gname', maxlength: '64', autocomplete: 'off', placeholder: 'Group name' });
    const desc = h('input', { class: 'input', id: 'gdesc', maxlength: '255', autocomplete: 'off', placeholder: 'What is this group for? (optional)' });
    const members = h('input', { class: 'input', id: 'gmem', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: '@alice, @bob' });
    const err = h('p', { class: 'msg-error', role: 'alert' });
    const go = h('button', { class: 'btn', type: 'submit' }, 'Create group');
    const m = modal('New group', [h('form', { onSubmit: async (e: Event) => {
      e.preventDefault(); err.textContent = '';
      if (!name.value.trim()) return void (err.textContent = 'Enter a group name.');
      go.disabled = true;
      try {
        const id = await client.gm.create(name.value, desc.value);
        const failed: string[] = [];
        for (const u of members.value.split(/[\s,]+/).map((x) => x.replace(/^@/, '')).filter(Boolean)) {
          try { await client.gm.addByUsername(id, u); } catch { failed.push(u); }
        }
        m.close(); open(`g:${id}`);
        if (failed.length) toast(`Could not add: ${failed.map((f) => '@' + f).join(', ')}`);
      } catch (e2) { err.textContent = (e2 as any)?.status === 429 ? 'You created too many groups. Try later.' : 'Could not create the group.'; go.disabled = false; }
    } },
      h('div', { class: 'field' }, h('label', { for: 'gname' }, 'Name'), name),
      h('div', { class: 'field' }, h('label', { for: 'gdesc' }, 'Description'), desc),
      h('div', { class: 'field' }, h('label', { for: 'gmem' }, 'Add people by username'), members, h('span', { class: 'muted small' }, 'Separate with commas. You can add more later.')),
      err, h('div', { class: 'actions' }, go, h('button', { class: 'btn secondary', type: 'button', onClick: () => m.close() }, 'Cancel')))]);
  }

  function groupInfo(chat: string) {
    const id = gid(chat);
    const body = h('div', {});
    const render = () => {
      const g = client.groups.get(id);
      if (!g) return;
      const admin = amAdmin(chat), owner = myRole(chat) === 'owner' && !g.removed;
      const act = (fn: () => Promise<unknown>, ok: string) => async () => { try { await fn(); toast(ok); } catch (e) { toast((e as Error).message || 'Action failed.'); } };
      const name = h('input', { class: 'input', id: 'ginfo-name', value: g.name, maxlength: '64', disabled: !admin || g.removed });
      const desc = h('input', { class: 'input', id: 'ginfo-desc', value: g.description, maxlength: '255', disabled: !admin || g.removed });
      const add = h('input', { class: 'input', id: 'ginfo-add', placeholder: '@username', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
      const linkOut = h('div', { class: 'kv' });
      body.replaceChildren(...kids(
        h('div', { class: 'field' }, h('label', { for: 'ginfo-name' }, 'Name'), name),
        h('div', { class: 'field' }, h('label', { for: 'ginfo-desc' }, 'Description'), desc),
        admin && !g.removed ? h('button', { class: 'btn secondary', type: 'button', onClick: act(() => client.gm.setMeta(id, name.value, desc.value), 'Saved') }, 'Save info') : null,
        h('div', { class: 'section' }, h('h3', {}, g.kind === 'channel' ? `Subscribers (${g.subscribers})${admin ? '' : ', admins shown'}` : `Members (${g.members.length})`),
          h('ul', { class: 'members' }, g.members.map((mb) => {
            const you = mb.accountId === me;
            const rowBtns: Node[] = [];
            if (!g.removed && !you && mb.role !== 'owner') {
              if (owner) rowBtns.push(h('button', { class: 'btn secondary small-btn', type: 'button', onClick: act(() => client.gm.setRole(id, mb.accountId, mb.role === 'admin' ? 'member' : 'admin'), 'Role updated') }, mb.role === 'admin' ? 'Remove admin' : 'Make admin'));
              if (admin && (mb.role === 'member' || owner)) rowBtns.push(h('button', { class: 'btn secondary small-btn', type: 'button', onClick: async () => { if (await confirmModal('Remove member?', `${person(mb.accountId)} will stop receiving new messages in this group.`, 'Remove')) await act(() => client.gm.removeMember(id, mb.accountId), 'Member removed')(); } }, 'Remove'));
              if (owner) rowBtns.push(h('button', { class: 'btn secondary small-btn', type: 'button', onClick: async () => { if (await confirmModal('Transfer ownership?', `${person(mb.accountId)} becomes the owner. You stay as an admin.`, 'Transfer', false)) await act(() => client.gm.transfer(id, mb.accountId), 'Ownership transferred')(); } }, 'Make owner'));
            }
            return h('li', {}, avatarEl(client, mb.accountId, 'avatar alt'), h('span', { class: 'grow' }, h('span', { class: 'name' }, you ? `${person(mb.accountId)} (you)` : person(mb.accountId)), h('span', { class: 'muted small role' }, mb.role)), ...rowBtns);
          }))),
        admin && !g.removed ? h('div', { class: 'section' }, h('h3', {}, g.kind === 'channel' ? 'Add subscribers' : 'Add people'),
          h('div', { class: 'row' }, add, h('button', { class: 'btn', type: 'button', onClick: act(async () => { await client.gm.addByUsername(id, add.value.trim()); add.value = ''; }, 'Member added') }, 'Add')),
          h('div', { class: 'row wrap mt14' },
            h('button', { class: 'btn secondary', type: 'button', onClick: async () => {
              try { const link = await client.gm.createInvite(id); linkOut.replaceChildren(h('code', {}, link), h('button', { class: 'btn secondary', type: 'button', onClick: () => copyText(link, 'Invite link copied') }, 'Copy link'), h('span', { class: 'muted small' }, 'Valid for 7 days, 50 uses. Anyone with the link can join.')); } catch { toast('Could not create a link.'); }
            } }, 'Create invite link'),
            h('button', { class: 'btn secondary', type: 'button', onClick: act(() => client.gm.revokeInvites(id), 'All invite links revoked') }, 'Revoke links')),
          linkOut) : null,
        !g.removed ? h('div', { class: 'section stack' },
          h('button', { class: 'btn secondary', type: 'button', onClick: async () => {
            if (!(await confirmModal('Leave group?', owner ? 'You are the owner. Transfer ownership first, or delete the group.' : 'You will stop receiving messages. You can rejoin only with a new invite.', 'Leave'))) return;
            try { await client.gm.leave(id); dlg.close(); } catch (e) { toast((e as any)?.status === 409 ? 'Transfer ownership before leaving.' : 'Could not leave.'); }
          } }, 'Leave group'),
          owner ? h('button', { class: 'btn danger', type: 'button', onClick: async () => {
            if (await confirmModal('Delete group for everyone?', 'The group is removed for all members. Messages stay on their devices.', 'Delete group')) { try { await client.gm.deleteGroup(id); dlg.close(); } catch { toast('Could not delete the group.'); } }
          } }, 'Delete group') : null) : null));
    };
    const dlg = modal(label(chat), [body, h('button', { class: 'btn secondary block mt14', type: 'button', onClick: () => dlg.close() }, 'Close')], { onClose: () => refreshers.delete(render) });
    render(); refreshers.add(render);
    void client.gm.resolveMembers(id).then(render);
  }

  // ---------- settings ----------
  function openSettings() {
    const mine = client.contacts.get(me)?.username;
    const uname = h('input', { class: 'input', id: 'uname', placeholder: 'choose_a_username', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: mine ?? '' });
    const unameMsg = h('p', { class: 'msg-error', role: 'alert' });
    const days = h('select', { class: 'input', id: 'days' }, [7, 30, 90, 180, 365].map((d) => h('option', { value: String(d) }, `${d} days`)));
    days.value = '365';
    const daysMsg = h('p', { class: 'msg-ok', role: 'status' });
    const np = getPrefs();
    const onBox = h('input', { type: 'checkbox', id: 'notif-on', checked: np.on && notificationsSupported });
    const modeSel = h('select', { class: 'input', id: 'notif-mode', disabled: !np.on }, [['hidden', 'Say only "New message"'], ['sender', 'Show who wrote'], ['full', 'Show the message text']].map(([v, t]) => h('option', { value: v }, t)));
    modeSel.value = np.mode;
    const notifHelp = h('p', { class: 'muted small' }, notificationsSupported ? 'Shown only while a Vanishgram tab is open and not in front. Text is hidden by default because notifications pass through your operating system, outside Vanishgram\'s encryption.' : 'This browser does not support notifications.');
    onBox.addEventListener('change', async () => {
      const want = (onBox as HTMLInputElement).checked;
      if (want) { const res = await enableNotifications(); if (res !== 'granted') { (onBox as HTMLInputElement).checked = false; toast(res === 'denied' ? 'Notifications are blocked. Allow them in the address bar.' : 'Notifications are not supported here.'); setPrefs({ on: false, mode: modeSel.value as NotifyMode }); modeSel.disabled = true; return; } }
      setPrefs({ on: want, mode: modeSel.value as NotifyMode }); modeSel.disabled = !want;
    });
    modeSel.addEventListener('change', () => setPrefs({ on: (onBox as HTMLInputElement).checked, mode: modeSel.value as NotifyMode }));
    const notifBox = h('div', { class: 'section' }, h('h3', {}, 'Notifications'), h('label', { class: 'check', for: 'notif-on' }, onBox, h('span', {}, 'Notify me about new messages')), h('div', { class: 'field' }, h('label', { for: 'notif-mode' }, 'What a notification shows'), modeSel), notifHelp);
    const relayBox = h('div', { class: 'section', hidden: true });
    void client.http<{ relayAvailable: boolean }>('GET', '/v1/calls/ice').then((r) => {
      if (!r.relayAvailable) return;
      const cb = h('input', { type: 'checkbox', id: 'relay', checked: localStorage.getItem('vg.relay') === '1', onChange: () => { localStorage.setItem('vg.relay', (cb as HTMLInputElement).checked ? '1' : '0'); } });
      relayBox.replaceChildren(h('h3', {}, 'Voice calls'), h('label', { class: 'check', for: 'relay' }, cb, h('span', {}, 'Hide my IP address by relaying calls through a server. Audio stays end-to-end encrypted, calls may sound slightly delayed.')));
      relayBox.hidden = false;
    }).catch(() => {});
    const m = modal('Profile and settings', [
      h('div', { class: 'row mb16' }, avatarEl(client, me, 'avatar lg'), h('div', {}, h('div', { class: 'name' }, mine ? `@${mine}` : 'No username yet'), h('div', { class: 'muted small' }, 'Others find you by username'))),
      h('form', { onSubmit: async (e: Event) => {
        e.preventDefault(); unameMsg.className = 'msg-error'; unameMsg.textContent = '';
        try {
          await client.setUsername(uname.value.trim().replace(/^@/, ''), true);
          client.contacts.delete(me); await client.resolveContact(me); setMe(); unameMsg.className = 'msg-ok'; unameMsg.textContent = 'Username saved.';
        } catch (err) {
          const s = (err as any)?.status; unameMsg.textContent = s === 409 ? 'That username is taken.' : s === 403 ? 'That username is reserved.' : s === 400 ? 'Use 3 to 32 characters: lowercase letters, digits, underscore. Start with a letter.' : 'Could not save the username.';
        }
      } }, h('div', { class: 'field' }, h('label', { for: 'uname' }, 'Username'), uname), unameMsg, h('button', { class: 'btn secondary', type: 'submit' }, 'Save username')),
      relayBox,
      notifBox,
      h('div', { class: 'section stack' },
        h('button', { class: 'btn secondary', type: 'button', onClick: () => editProfileDialog(client, () => { setMe(); schedule(); }) }, 'Edit profile'),
        h('button', { class: 'btn secondary', type: 'button', onClick: () => privacyDialog(client, person) }, 'Privacy and blocking'),
        h('button', { class: 'btn secondary', type: 'button', onClick: () => securityDialog(client) }, 'Security and two-step verification'),
        h('button', { class: 'btn secondary', type: 'button', onClick: () => devicesDialog(client) }, 'Devices')),
      h('div', { class: 'section' }, h('h3', {}, 'Automatic account deletion'),
        h('p', { class: 'muted small' }, 'If you do not sign in for this long, your account is deleted from the server. This cannot be turned off.'),
        h('div', { class: 'field' }, h('label', { for: 'days' }, 'Delete after inactivity'), days), daysMsg,
        h('button', { class: 'btn secondary', type: 'button', onClick: async () => {
          try { await client.http('PUT', '/v1/account/inactivity', { days: Number(days.value) }); daysMsg.textContent = 'Saved.'; } catch { daysMsg.className = 'msg-error'; daysMsg.textContent = 'Could not save.'; }
        } }, 'Save period')),
      h('div', { class: 'section' }, h('h3', {}, 'Your account ID'),
        h('div', { class: 'kv' }, h('code', {}, me)), h('button', { class: 'btn secondary', type: 'button', onClick: () => copyText(me) }, 'Copy ID')),
      h('div', { class: 'section stack' },
        api.entries().length > 1 ? h('button', { class: 'btn secondary', type: 'button', onClick: async () => {
          if (await confirmModal('Sign out of every account?', 'Encrypted data for all accounts on this device is deleted. You can sign in again with each recovery phrase. Old messages will not come back.', 'Sign out of all')) { m.close(); await api.logoutAll(); }
        } }, 'Sign out of all accounts') : null,
        h('button', { class: 'btn secondary', type: 'button', onClick: async () => {
          if (await confirmModal('Sign out of this device?', 'Encrypted data on this device is deleted. Sign in again with your recovery phrase. Old messages will not come back.', 'Sign out')) { m.close(); await client.wipe(); onLogout(); }
        } }, 'Sign out of this device'),
        h('button', { class: 'btn danger', type: 'button', onClick: async () => {
          if (await confirmModal('Delete account permanently?', 'Your account, username and queued messages are removed from the server. This cannot be undone.', 'Delete account')) {
            try { await client.http('DELETE', '/v1/account'); await new IdbBackend(me).remove(); client.close(); m.close(); onLogout(); } catch { toast('Could not delete the account.'); }
          }
        } }, 'Delete account'),
        h('p', { class: 'muted small' }, h('a', { href: page('/privacy'), target: '_blank', rel: 'noopener' }, 'Privacy Policy'), ' · ', h('a', { href: page('/terms'), target: '_blank', rel: 'noopener' }, 'Terms and Conditions'))),
      h('button', { class: 'btn secondary block mt14', type: 'button', onClick: () => m.close() }, 'Close'),
    ]);
  }

  // ---------- live updates ----------
  function setMe() {
    const u = client.contacts.get(me)?.username, pm = client.profile.me;
    meName.textContent = pm.displayName || (u ? `@${u}` : 'Set a username');
    api.setLabel(me, pm.displayName || (u ? `@${u}` : `Account ${me.slice(0, 8)}`));
    const sig = `${pm.avatarVersion}|${pm.displayName}|${u}`;
    if (sig !== meSig) { meSig = sig; const n = avatarEl(client, me); meAvatar.replaceWith(n); meAvatar = n; }
  }
  let paneSig = '';
  const sigOf = (id: string) => [label(id), grp(id)?.members.length, grp(id)?.removed, grp(id)?.subscribers, pubCh(id)?.subscribers, myRole(id), client.blockedSet.has(id), client.x.ttlOf(id), client.muted.has(id), client.x.isPinned(id), client.x.isArchived(id)].join('|');
  let dirty = false;
  const schedule = () => {
    if (document.hidden) { dirty = true; return; } // nothing to draw for a hidden tab: catch up when it comes back
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      dirty = false;
      if (active) {
        const sig = sigOf(active);
        if (sig !== paneSig) { paneSig = sig; if (textarea) client.x.setDraft(active, textarea.value); renderPane(); }
        if (subEl) subEl.textContent = chatSub(active);
        renderPin();
      }
      renderList(); renderMessages(); setMe();
      refreshers.forEach((f) => f());
    });
  };
  client.onChange = schedule;
  client.onMessage = (peer, m) => {
    if (m.from !== me && !m.sys && !client.muted.has(peer)) {
      const np = getPrefs();
      notify({ title: np.mode === 'hidden' ? 'Vanishgram' : label(peer), body: np.mode === 'full' ? (m.file ? fileLabel(m.file) : m.body.slice(0, 140)) : 'New message', tag: peer, onClick: () => open(peer) });
    }
    if ((peer !== active || document.hidden) && !client.muted.has(peer)) unread.set(peer, (unread.get(peer) ?? 0) + 1);
    if (peer === active && !document.hidden && kindOf(peer) === 'dm') void client.profile.markRead(peer);
    if (document.hidden && 'title' in document) document.title = '(new) Vanishgram';
    schedule();
  };
  client.onError = () => { /* a single undecryptable message must not break the UI */ };
  client.onSessionLost = () => {
    if (disposed) return;
    void modal('Signed out', [h('p', {}, 'This device was signed out of the account from another device or by the service. Its encrypted data is removed. Sign in again with your recovery phrase.'), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onClick: async () => { await client.wipe().catch(() => {}); onLogout(); } }, 'OK'))], { onClose: () => { void client.wipe().catch(() => {}); onLogout(); } });
  };
  listen('visibilitychange', () => { if (!document.hidden && dirty) schedule(); if (!document.hidden) { document.title = 'Vanishgram'; if (active) { unread.delete(active); if (kindOf(active) === 'dm') void client.profile.markRead(active); schedule(); } } });
  client.onTyping = (peer) => { typingUntil.set(peer, Date.now() + 5000); schedule(); setTimeout(schedule, 5200); };
  listen('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchInput.focus(); } });

  let attempt = 0;
  const setStatus = (on: boolean) => { connected = on; banner.hidden = on; };
  const connect = async () => {
    if (disposed) return;
    if (client.connected) { setStatus(true); return; } // switching back to an account that stayed online
    try { await client.connect(); attempt = 0; setStatus(true); }
    catch { setStatus(false); setTimeout(connect, Math.min(30000, 1000 * 2 ** attempt++)); }
  };
  client.onDisconnect = () => { if (disposed) return; setStatus(false); setTimeout(connect, 1000); };
  void connected;

  renderList(); renderPane(); setMe();
  void client.resolveContact(me).then(setMe).catch(() => {});
  void client.profile.load().then(() => { setMe(); schedule(); }).catch(() => {});
  void client.profile.blocked().then((ids) => { client.blockedSet = new Set(ids); }).catch(() => {});
  void connect();

  // Moving chats between devices: an older device of this account approves, a new one asks once after signing in with the phrase.
  client.history.onRequest = (req, approve) => {
    void confirmModal('Send your chat history?', `"${req.label}" signed in to your account and asks for your chats. Only approve if that is you. The history travels encrypted and never leaves your devices unencrypted.`, 'Send', false).then(async (yes) => {
      if (!yes) return;
      try { await approve(); toast('History sent.'); } catch { toast('Could not send the history.'); }
    });
  };
  client.history.onImported = (n) => toast(n ? `Copied ${n} messages from your other device.` : 'Your other device had nothing new to copy.');
  if (client.wantHistory) {
    client.wantHistory = false;
    void client.history.request().then((n) => { if (n) toast('To copy your chats: open Vanishgram on your other device and approve.'); }).catch(() => {});
  }

  if (joinLink && joinLink.includes('#channel=')) {
    const name = /#channel=([a-z0-9_]+)/i.exec(joinLink)?.[1];
    if (name) void client.ch.lookup(name).then((ch) => open(`c:${ch.id}`)).catch(() => toast('Channel not found.'));
  } else if (joinLink) {
    void confirmModal('Join this group?', 'You will see messages sent after you join. Members can see your username.', 'Join', false).then(async (yes) => {
      if (!yes) return;
      try { open(`g:${await client.gm.join(joinLink)}`); } catch { toast('This invite link is invalid, expired or used up.'); }
    });
  }

  // Everything this screen attached, so another account can take its place while this one stays online in the background.
  return () => {
    disposed = true;
    cleanups.forEach((f) => f());
    clearInterval(presenceTimer); cancelAnimationFrame(raf);
    stopRing(); callBox?.remove(); viewObserver?.disconnect();
    document.querySelectorAll('.overlay, .menu, .drawer-overlay, .lightbox').forEach((n) => n.remove());
    client.onChange = () => {}; client.onMessage = () => {}; client.onTyping = () => {}; client.onCall = () => {}; client.onDisconnect = () => {};
  };
}
