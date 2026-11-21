// Chat features that live entirely on the devices: editing, reactions, forwarding, pinned/archived chats,
// folders, drafts, search and disappearing messages. Anything the other side must see travels as an
// encrypted envelope; organisation (pins, folders, mute) syncs to your OTHER devices the same way.
// The server learns none of it.
import { DEFAULT_LIMITS, type ChatPrefs, type Envelope } from '@vanishgram/protocol';
import { hex } from './encoding.ts';
import type { VanishClient, ChatMessage } from './client.ts';

export const TTL_CHOICES = [0, 30, 3600, 86400, 604800] as const; // seconds; 0 = off
export interface SearchHit { chat: string; message: ChatMessage }
export const emptyPrefs = (): ChatPrefs => ({ pinned: [], archived: [], muted: [], folders: [], ts: 0 });

const isGroupChat = (chat: string) => chat.startsWith('g:');
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

export class ExtrasManager {
  c: VanishClient;
  constructor(c: VanishClient) { this.c = c; }
  /** Set once any message carries an expiry, so the 5 second scan can stay idle for everyone else. */
  hasExpiring = false;
  private touch() { this.c.onChange(); this.c.flushSoon(); }

  // ---------- sending an envelope into a chat (and to my other devices for DMs) ----------
  private async sendInto(chat: string, env: Envelope, mirrorToMe = true) {
    const c = this.c;
    if (isGroupChat(chat)) { await c.gm.sendEnvelope(chat.slice(2), env); return; }
    if (chat === c.account.accountId) return; // saved messages: nothing to tell a peer
    await c.deliver(chat, env);
    if (mirrorToMe) await c.deliver(c.account.accountId, { ...env, chat } as Envelope).catch(() => {});
  }
  private find(chat: string, id: string) { return this.c.chats.get(chat)?.find((m) => m.id === id); }

  // ---------- edit ----------
  async edit(chat: string, id: string, body: string) {
    const m = this.find(chat, id);
    if (!m || m.from !== this.c.account.accountId || m.sys) throw new Error('you can only edit your own messages');
    if (!body.trim() || [...body].length > 4096) throw new Error('invalid message');
    m.body = body; m.edited = true; this.touch();
    await this.sendInto(chat, { t: 'edit', target: id, body, ts: Date.now() });
  }

  // ---------- reactions: one per person per message ----------
  async react(chat: string, id: string, emoji: string | null) {
    const m = this.find(chat, id), me = this.c.account.accountId;
    if (!m) return;
    this.applyReaction(m, me, emoji); this.touch();
    await this.sendInto(chat, { t: 'react', target: id, emoji, ts: Date.now() });
  }
  private applyReaction(m: ChatMessage, who: string, emoji: string | null) {
    if (emoji && [...emoji].length <= 4) { (m.reactions ??= {})[who] = emoji; }
    else if (m.reactions) { delete m.reactions[who]; if (!Object.keys(m.reactions).length) delete m.reactions; }
  }

  // ---------- forward ----------
  async forward(toChat: string, m: ChatMessage, fromLabel: string) {
    if (m.sys) throw new Error('cannot forward this');
    if (m.file) return this.c.files.post(toChat, m.file, m.body || undefined, undefined, fromLabel);
    return isGroupChat(toChat) ? this.c.gm.sendText(toChat.slice(2), m.body, undefined, fromLabel) : this.c.sendText(toChat, m.body, undefined, fromLabel);
  }

  // ---------- disappearing messages ----------
  ttlOf(chat: string): number { return this.c.ttl.get(chat)?.seconds ?? 0; }
  async setTtl(chat: string, seconds: number) {
    if (!TTL_CHOICES.includes(seconds as any)) throw new Error('unsupported timer');
    if (isGroupChat(chat)) { const g = this.c.groups.get(chat.slice(2)); const r = g?.members.find((x) => x.accountId === this.c.account.accountId)?.role; if (r !== 'owner' && r !== 'admin') throw new Error('admins only'); }
    const ts = Date.now();
    this.applyTtl(chat, seconds, ts);
    await this.sendInto(chat, { t: 'ttl', seconds, ts });
  }
  private applyTtl(chat: string, seconds: number, ts: number) {
    const cur = this.c.ttl.get(chat);
    if (cur && cur.ts >= ts) return;
    this.c.ttl.set(chat, { seconds, ts });
    const label = seconds === 0 ? 'Disappearing messages turned off' : `Messages now disappear after ${seconds < 3600 ? `${seconds} seconds` : seconds < 86400 ? `${seconds / 3600} hour` : seconds === 86400 ? '1 day' : '1 week'}`;
    this.c.store(chat, { id: `ttl-${ts}`, from: this.c.account.accountId, body: label, ts, serverIds: [], sys: true });
  }
  /** Stamp a message with its expiry (called for every stored message). */
  stamp(chat: string, m: ChatMessage) {
    const t = this.c.ttl.get(chat)?.seconds;
    if (t && !m.sys && m.exp === undefined) { m.exp = m.ts + t * 1000; this.hasExpiring = true; }
  }
  /** Remove messages whose time is up. Local only; screenshots and modified clients are out of reach. */
  sweep(now = Date.now()): number {
    let n = 0;
    if (!this.c.ttl.size && !this.hasExpiring) return 0; // no disappearing timers anywhere: skip the scan
    for (const [chat, list] of this.c.chats) for (const m of [...list]) if (m.exp !== undefined && m.exp <= now) { this.c.tombstones.add(m.id); this.c.remove(chat, m.id); n++; }
    return n;
  }

  // ---------- organisation, synced to my other devices ----------
  get prefs(): ChatPrefs { return this.c.prefs; }
  private async savePrefs() {
    const p = this.c.prefs; p.ts = Date.now(); p.muted = [...this.c.muted];
    this.touch();
    await this.c.deliver(this.c.account.accountId, { t: 'prefs', prefs: p, ts: p.ts }).catch(() => {});
  }
  isPinned(chat: string) { return this.c.prefs.pinned.includes(chat); }
  isArchived(chat: string) { return this.c.prefs.archived.includes(chat); }
  async pinChat(chat: string, on: boolean) {
    const p = this.c.prefs;
    if (on && !p.pinned.includes(chat)) { if (p.pinned.length >= DEFAULT_LIMITS.maxPinnedChats) throw new Error(`you can pin at most ${DEFAULT_LIMITS.maxPinnedChats} chats`); p.pinned.push(chat); }
    if (!on) p.pinned = p.pinned.filter((x) => x !== chat);
    await this.savePrefs();
  }
  async archiveChat(chat: string, on: boolean) {
    const p = this.c.prefs;
    p.archived = on ? [...new Set([...p.archived, chat])] : p.archived.filter((x) => x !== chat);
    if (on) p.pinned = p.pinned.filter((x) => x !== chat);
    await this.savePrefs();
  }
  async setMuted(chat: string, on: boolean) { if (on) this.c.muted.add(chat); else this.c.muted.delete(chat); await this.savePrefs(); }
  async createFolder(name: string): Promise<string> {
    name = name.trim();
    if (!name || [...name].length > 24) throw new Error('folder names are 1 to 24 characters');
    if (this.c.prefs.folders.length >= 10) throw new Error('at most 10 folders');
    const id = hex(crypto.getRandomValues(new Uint8Array(4)));
    this.c.prefs.folders.push({ id, name, chats: [] });
    await this.savePrefs(); return id;
  }
  async renameFolder(id: string, name: string) { const f = this.c.prefs.folders.find((x) => x.id === id); if (f && name.trim()) { f.name = name.trim().slice(0, 24); await this.savePrefs(); } }
  async deleteFolder(id: string) { this.c.prefs.folders = this.c.prefs.folders.filter((x) => x.id !== id); await this.savePrefs(); }
  async setInFolder(id: string, chat: string, on: boolean) {
    const f = this.c.prefs.folders.find((x) => x.id === id);
    if (!f) return;
    f.chats = on ? [...new Set([...f.chats, chat])] : f.chats.filter((x) => x !== chat);
    await this.savePrefs();
  }

  // ---------- drafts: stored encrypted in the vault, never sent anywhere ----------
  setDraft(chat: string, text: string) { if (text) this.c.drafts.set(chat, text); else this.c.drafts.delete(chat); this.c.flushSoon(); }
  draft(chat: string) { return this.c.drafts.get(chat) ?? ''; }

  // ---------- search over decrypted history, on this device only ----------
  search(query: string, opts: { chat?: string; limit?: number } = {}): SearchHit[] {
    const q = norm(query.trim());
    if (q.length < 2) return [];
    const hits: SearchHit[] = [];
    for (const [chat, list] of this.c.chats) {
      if (opts.chat && chat !== opts.chat) continue;
      for (const m of list) if (!m.sys && (norm(m.body).includes(q) || (m.file && norm(m.file.name).includes(q)))) hits.push({ chat, message: m });
    }
    return hits.sort((a, b) => b.message.ts - a.message.ts).slice(0, opts.limit ?? 100);
  }

  // ---------- inbound ----------
  /** `from` is the account the envelope came from; `chat` is where it applies. */
  onEnvelope(chat: string, from: string, env: Envelope, canAdmin = false) {
    const me = this.c.account.accountId;
    if (env.t === 'edit') {
      const m = this.find(chat, env.target);
      if (m && m.from === from && !m.sys) { m.body = env.body; m.edited = true; this.touch(); }
    } else if (env.t === 'react') {
      const m = this.find(chat, env.target);
      if (m) { this.applyReaction(m, from, env.emoji); this.touch(); }
    } else if (env.t === 'ttl') {
      if (isGroupChat(chat) && !canAdmin) return; // only admins change a group's timer
      this.applyTtl(chat, env.seconds, env.ts); this.touch();
    } else if (env.t === 'prefs' && from === me) {
      const cur = this.c.prefs;
      if (env.ts > cur.ts) { this.c.prefs = { ...emptyPrefs(), ...env.prefs }; this.c.muted = new Set(env.prefs.muted); this.touch(); }
    }
  }
}
