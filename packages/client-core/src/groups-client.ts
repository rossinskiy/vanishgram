// Client side of private groups. The server holds only the roster and roles; names, descriptions,
// pins and messages are end-to-end encrypted (sender-key chains, see groupkeys.ts).
import type { Envelope, WireMessage } from '@vanishgram/protocol';
import { b64, unb64, utf8, fromUtf8, hex } from './encoding.ts';
import * as G from './groupkeys.ts';
import { MlsGroups } from './mls-groups.ts';
import type { GroupMeta } from './mls.ts';
import type { VanishClient, ChatMessage } from './client.ts';

export type Role = 'owner' | 'admin' | 'member';
export interface Member { accountId: string; role: Role }
export interface GroupState {
  id: string; name: string; description: string; pinned: string | null; metaTs: number; rev: number;
  kind: 'group' | 'channel'; visibility: 'private' | 'public'; subscribers: number;
  members: Member[]; myChain: G.OwnChain; distributedTo: Set<string>; undistributed: boolean; removed: boolean;
}
export type PendingGroupMsg = WireMessage;

const isAdmin = (r?: Role) => r === 'owner' || r === 'admin';
export const groupChatId = (gid: string) => `g:${gid}`;

export class GroupManager {
  c: VanishClient;
  private lock: Promise<unknown> = Promise.resolve();
  readonly mls: MlsGroups;
  constructor(c: VanishClient) {
    this.c = c;
    // Private groups use MLS (see mls-groups.ts). Private channels keep sender keys: their subscribers must not learn each other's identities.
    this.mls = new MlsGroups(c, {
      group: (gid) => c.groups.get(gid),
      isAdmin: (g, a) => isAdmin(this.roleOf(g, a)),
      refresh: (gid, force) => this.syncInner(gid, force),
      deliverEnvelope: (g, from, env, w) => this.handleEnv(g, from, env, w),
      applyMeta: (g, m) => this.applyMetaObj(g, m),
      later: (fn, ms) => { const t = setTimeout(() => { void this.locked(fn).catch((e) => c.onError(e)); }, ms); (t as any).unref?.(); },
      touch: () => this.touch(),
    });
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.lock.then(fn, fn);
    this.lock = r.catch(() => {});
    return r;
  }
  private touch() { this.c.onChange(); this.c.flushSoon(); }
  private roleOf = (g: GroupState, acct: string) => g.members.find((m) => m.accountId === acct)?.role;
  get(gid: string): GroupState {
    const g = this.c.groups.get(gid);
    if (!g) throw new Error('unknown group');
    return g;
  }

  // ---------- roster sync (the only place keys are rotated or handed out) ----------
  syncGroup(gid: string, force = false) { return this.locked(() => this.syncInner(gid, force)); }

  private async syncInner(gid: string, force = false) {
    const c = this.c;
    let info: { rev: number; kind?: 'group' | 'channel'; visibility?: 'private' | 'public'; subscribers?: number; members: Member[] };
    try { info = await c.http('GET', `/v1/groups/${gid}`); }
    catch (e) {
      if ((e as any)?.status === 404) { const g = c.groups.get(gid); if (g && !g.removed) { g.removed = true; this.touch(); } this.mls.forget(gid); return; }
      throw e;
    }
    if (info.kind === 'channel' && info.visibility === 'public') return; // public channels have no keys: ChannelManager owns them
    let g = c.groups.get(gid);
    if (!g) {
      g = { id: gid, name: '', description: '', pinned: null, metaTs: 0, rev: -1, kind: info.kind ?? 'group', visibility: info.visibility ?? 'private', subscribers: 0, members: [], myChain: G.newChain(), distributedTo: new Set(), undistributed: true, removed: false };
      c.groups.set(gid, g);
      if (!c.chats.has(groupChatId(gid))) c.chats.set(groupChatId(gid), []);
    }
    if (!force && info.rev === g.rev && !g.removed) return;
    const prev = new Set(g.members.map((m) => m.accountId)), now = new Set(info.members.map((m) => m.accountId));
    const left = [...prev].filter((a) => !now.has(a));
    const joined = [...now].filter((a) => !prev.has(a));
    g.members = info.members; g.rev = info.rev; g.removed = false;
    g.kind = info.kind ?? 'group'; g.visibility = info.visibility ?? 'private'; g.subscribers = info.subscribers ?? info.members.length;
    if (g.kind === 'group') { // MLS: membership changes become commits (see mls-groups.ts); no sender keys
      g.undistributed = false;
      if (this.mls.has(gid)) this.mls.scheduleReconcile(gid);
      else { const t = setTimeout(() => { void this.mls.askToJoin(gid); }, 15_000); (t as any).unref?.(); }
      this.touch(); return;
    }
    // Channel subscribers never send, so they hold no chain, rotate nothing and hand out nothing.
    if (g.kind === 'channel' && !isAdmin(this.roleOf(g, c.account.accountId))) {
      for (const k of [...c.recvChains.keys()]) { const [kg, ka] = k.split(':'); if (kg === gid && left.includes(ka!)) c.recvChains.delete(k); }
      g.undistributed = false; this.touch(); return;
    }
    if (left.length) {
      // Someone was removed: start a fresh chain they never receive, and forget their chains.
      g.myChain = G.newChain(); g.distributedTo = new Set(); g.undistributed = true;
      for (const k of [...c.recvChains.keys()]) { const [kg, ka] = k.split(':'); if (kg === gid && left.includes(ka!)) c.recvChains.delete(k); }
    }
    if (joined.length || left.length || g.distributedTo.size === 0) g.undistributed = true;
    if (g.undistributed) await this.distribute(g);
    this.touch();
  }

  /** Give my current chain (and, if I am an admin, the group info) to every member device that lacks it. */
  private async distribute(g: GroupState) {
    const c = this.c, me = c.account.accountId, amAdmin = isAdmin(this.roleOf(g, me));
    let ok = true;
    for (const m of g.members) {
      let bundles;
      try { bundles = await c.peerBundles(m.accountId); } catch { ok = false; continue; }
      for (const b of bundles) {
        if (m.accountId === me && b.deviceId === c.device.deviceId) continue;
        const k = `${m.accountId}:${b.deviceId}`;
        if (g.distributedTo.has(k)) continue;
        try {
          const d = G.distributionOf(g.myChain);
          await c.deliver(m.accountId, { t: 'sender-key', groupId: g.id, ...d }, b.deviceId);
          if (amAdmin && g.metaTs > 0) await c.deliver(m.accountId, { t: 'group-meta', groupId: g.id, name: g.name, description: g.description, pinned: g.pinned, ts: g.metaTs }, b.deviceId);
          g.distributedTo.add(k);
        } catch (e) { ok = false; c.onError(e); }
      }
    }
    g.undistributed = !ok;
  }

  syncAll() {
    return this.locked(async () => {
      const { groups } = await this.c.http<{ groups: { id: string; rev: number; kind?: string; visibility?: string }[] }>('GET', '/v1/groups');
      const live = new Set(groups.map((x) => x.id));
      for (const [id] of this.c.channels) if (!live.has(id)) { const ch = this.c.channels.get(id)!; if (ch.role) { this.c.channels.delete(id); } }
      for (const x of groups) {
        if (x.kind === 'channel' && x.visibility === 'public') { await this.c.ch.syncMember(x.id); continue; } const g = this.c.groups.get(x.id); if (!g || g.rev < x.rev || g.removed) await this.syncInner(x.id); if (x.kind !== 'channel' && !this.mls.has(x.id)) { const t = setTimeout(() => { void this.mls.askToJoin(x.id); }, 15_000); (t as any).unref?.(); } }
      for (const g of this.c.groups.values()) if (!live.has(g.id) && !g.removed) { g.removed = true; this.mls.forget(g.id); this.touch(); }
    });
  }

  onEvent(f: { id: string; groupId: string; resync?: { account: string; device: string } }) {
    return this.locked(async () => {
      if (f.resync && typeof f.resync.account === 'string' && typeof f.resync.device === 'string') this.mls.noteResync(f.groupId, f.resync.account, f.resync.device);
      try { await this.syncInner(f.groupId, !!f.resync); await this.c.flush(); }
      catch (e) { this.c.onError(e); }
      finally { this.c.ack(f.id); } // events are idempotent; syncAll repairs a failed one on reconnect
    });
  }

  // ---------- inbound ----------
  /** Sender keys and group info arrive over pairwise sessions. */
  onPairwise(from: string, fromDevice: string, env: Envelope) {
    return this.locked(async () => {
      const c = this.c;
      if (env.t === 'sender-key') {
        c.recvChains.set(`${env.groupId}:${from}:${fromDevice}:${env.chainId}`, G.receiverFrom({ chainId: env.chainId, ck: env.ck, n: env.n, signPub: env.signPub }));
        if (!c.groups.has(env.groupId)) await this.syncInner(env.groupId).catch((e) => c.onError(e));
        await this.drain(env.groupId);
      } else if (env.t === 'group-meta') {
        if (!c.groups.has(env.groupId)) await this.syncInner(env.groupId).catch((e) => c.onError(e));
        const g = c.groups.get(env.groupId);
        if (g && isAdmin(this.roleOf(g, from))) this.applyMeta(g, env);
      }
      this.touch();
    });
  }

  private applyMetaObj(g: GroupState, m: GroupMeta) {
    if (m.ts < g.metaTs || (m.ts === g.metaTs && g.name)) return;
    g.name = String(m.name).slice(0, 64); g.description = String(m.description).slice(0, 255); g.pinned = m.pinned; g.metaTs = m.ts;
  }

  private applyMeta(g: GroupState, env: Extract<Envelope, { t: 'group-meta' }>) {
    if (env.ts <= g.metaTs) return;
    g.name = String(env.name).slice(0, 64); g.description = String(env.description).slice(0, 255);
    g.pinned = env.pinned; g.metaTs = env.ts;
  }

  receiveGroup(w: WireMessage) {
    return this.locked(async () => {
      const c = this.c;
      try {
        const gid = w.group!;
        if (w.mls === 'welcome') { await this.mls.onWelcome(w); await this.drainMls(gid); await c.flush(); return; }
        if (w.mls === 'commit') { await this.mls.onCommit(w); await this.drainMls(gid); await c.flush(); return; }
        if (!c.groups.has(gid)) await this.syncInner(gid);
        let g = c.groups.get(gid);
        if (g && !this.roleOf(g, w.from)) { await this.syncInner(gid, true); g = c.groups.get(gid); } // roster may be stale
        if (!g || !this.roleOf(g, w.from)) return; // not a member: drop
        if (g.kind === 'group') {
          if (!(await this.mls.onMessage(g, w)) && this.c.pendingGroup.length < 500) this.c.pendingGroup.push(w); // keys not here yet: keep until the welcome arrives
        } else if (!(await this.decryptAndHandle(g, w))) {
          if (this.c.pendingGroup.length < 500) this.c.pendingGroup.push(w); // sender key not here yet: keep until it arrives
        }
        await c.flush();
      } catch (e) { c.onError(e); }
      finally { c.ack(w.id); }
    });
  }

  private async decryptAndHandle(g: GroupState, w: WireMessage): Promise<boolean> {
    const wire = unb64(w.body);
    const rkey = `${g.id}:${w.from}:${w.fromDevice}:${G.chainIdOf(wire)}`;
    const rc = this.c.recvChains.get(rkey);
    if (!rc) return false;
    try {
      const r = G.decrypt(rc, g.id, w.from, w.fromDevice, wire);
      this.c.recvChains.set(rkey, r.chain);
      this.handleEnv(g, w.from, JSON.parse(fromUtf8(r.plaintext)) as Envelope, w);
    } catch (e) { this.c.onError(e); } // forged, replayed or corrupt: drop it
    return true;
  }

  /** Retry messages that arrived before this device had the group's keys. */
  private async drainMls(gid: string) {
    const g = this.c.groups.get(gid);
    if (!g || g.kind !== 'group' || !this.mls.has(gid)) return;
    const left: WireMessage[] = [];
    for (const w of this.c.pendingGroup) { if (w.group !== gid || w.mls || !(await this.mls.onMessage(g, w))) left.push(w); }
    this.c.pendingGroup = left;
  }

  private async drain(gid: string) {
    const g = this.c.groups.get(gid);
    if (!g) return;
    const left: WireMessage[] = [];
    for (const w of this.c.pendingGroup) { if (w.group !== gid || !(await this.decryptAndHandle(g, w))) left.push(w); }
    this.c.pendingGroup = left;
  }

  private handleEnv(g: GroupState, from: string, env: Envelope, w: WireMessage) {
    const c = this.c, chat = groupChatId(g.id);
    if (g.kind === 'channel' && !isAdmin(this.roleOf(g, from))) return; // subscribers cannot post, whatever the ciphertext says
    if (env.t === 'file') {
      if (c.tombstones.has(env.id)) return;
      const m = c.store(chat, { id: env.id, from, body: env.body ?? '', ts: env.ts, replyTo: env.replyTo, serverIds: [w.id], file: env.file, ...(env.fwd ? { fwd: env.fwd } : {}) });
      c.onMessage(chat, m);
    } else if (env.t === 'text') {
      if (c.tombstones.has(env.id)) return;
      const m = c.store(chat, { id: env.id, from, body: env.body, ts: env.ts, replyTo: env.replyTo, serverIds: [w.id], ...(env.fwd ? { fwd: env.fwd } : {}) });
      c.onMessage(chat, m);
    } else if (env.t === 'edit' || env.t === 'react' || env.t === 'ttl') {
      c.x.onEnvelope(chat, from, env, isAdmin(this.roleOf(g, from)));
    } else if (env.t === 'group-meta') {
      if (isAdmin(this.roleOf(g, from))) this.applyMeta(g, env);
    } else if (env.t === 'pin') {
      if (isAdmin(this.roleOf(g, from))) g.pinned = env.target;
    } else if (env.t === 'delete-everyone') {
      const target = c.chats.get(chat)?.find((m) => m.id === env.target);
      if (!target || target.from === from || isAdmin(this.roleOf(g, from))) { c.tombstones.add(env.target); c.remove(chat, env.target); }
    }
    this.touch();
  }

  // ---------- outbound ----------
  sendEnvelope(gid: string, env: Envelope) { return this.sendEnv(gid, env); }
  private sendEnv(gid: string, env: Envelope): Promise<string[]> {
    return this.locked(async () => {
      const c = this.c, g = this.get(gid);
      if (g.removed) throw new Error('you are not in this group');
      if (g.kind === 'channel' && !isAdmin(this.roleOf(g, c.account.accountId))) throw new Error('only admins can post');
      if (g.kind === 'group') {
        const bytes = await this.mls.encryptEnvelope(gid, env);
        await c.flush(); // the group ratchet advanced: persist before the ciphertext leaves
        return (await c.http<{ ids: string[] }>('POST', `/v1/groups/${gid}/messages`, { body: b64(bytes) })).ids;
      }
      if (g.undistributed) await this.distribute(g);
      const wire = G.encrypt(g.myChain, gid, c.account.accountId, c.device.deviceId, utf8(JSON.stringify(env)));
      await c.flush(); // chain advanced: persist before the ciphertext leaves
      const r = await c.http<{ ids: string[] }>('POST', `/v1/groups/${gid}/messages`, { body: b64(wire) });
      return r.ids;
    });
  }

  async sendText(gid: string, body: string, replyTo?: string, fwd?: string): Promise<ChatMessage> {
    if ([...body].length > 4096) throw new Error('message too long');
    const id = hex(crypto.getRandomValues(new Uint8Array(12)));
    const env: Envelope = { t: 'text', id, body, ts: Date.now(), ...(replyTo ? { replyTo } : {}), ...(fwd ? { fwd } : {}) };
    const serverIds = await this.sendEnv(gid, env);
    return this.c.store(groupChatId(gid), { id, from: this.c.account.accountId, body, ts: env.ts, replyTo, serverIds, ...(fwd ? { fwd } : {}) });
  }

  /** Author or admin can delete for everyone; everyone can delete for themselves with deleteForMe. */
  async deleteForEveryone(gid: string, id: string) {
    const c = this.c, chat = groupChatId(gid), msg = c.chats.get(chat)?.find((m) => m.id === id);
    if (msg?.file && msg.from === c.account.accountId) await c.files.removeForEveryone(msg.file.fileId);
    c.tombstones.add(id); c.remove(chat, id);
    if (msg) for (const sid of msg.serverIds) await c.http('DELETE', `/v1/messages/${sid}`).catch(() => {});
    await this.sendEnv(gid, { t: 'delete-everyone', target: id, ts: Date.now() });
  }

  /** An MLS commit that changes the group info. If another commit won the epoch, wait for it to arrive and try again. */
  private async commitMeta(gid: string, meta: GroupMeta) {
    for (let attempt = 0; ; attempt++) {
      try { await this.locked(() => this.mls.commitMeta(gid, meta)); return; }
      catch (e) { if ((e as any)?.status !== 409 || attempt >= 5) throw e; await new Promise((r) => setTimeout(r, 400 + Math.random() * 600)); }
    }
  }

  async setMeta(gid: string, name: string, description = '') {
    const g = this.get(gid);
    if (!isAdmin(this.roleOf(g, this.c.account.accountId))) throw new Error('admins only');
    name = name.trim();
    if (!name || [...name].length > 64 || [...description].length > 255) throw new Error('invalid group info');
    g.name = name; g.description = description; g.metaTs = Math.max(Date.now(), g.metaTs + 1);
    if (g.kind === 'group') { await this.commitMeta(gid, { name, description, pinned: g.pinned, ts: g.metaTs }); this.touch(); return; }
    await this.sendEnv(gid, { t: 'group-meta', groupId: gid, name, description, pinned: g.pinned, ts: g.metaTs });
    this.touch();
  }

  async pin(gid: string, target: string | null) {
    const g = this.get(gid);
    if (!isAdmin(this.roleOf(g, this.c.account.accountId))) throw new Error('admins only');
    g.pinned = target;
    if (g.kind === 'group') { await this.commitMeta(gid, { name: g.name, description: g.description, pinned: target, ts: Math.max(Date.now(), g.metaTs + 1) }); this.touch(); return; }
    await this.sendEnv(gid, { t: 'pin', target, ts: Date.now() });
    this.touch();
  }

  async create(name: string, description = ''): Promise<string> {
    const { id } = await this.c.http<{ id: string }>('POST', '/v1/groups');
    await this.syncGroup(id);
    await this.locked(() => this.mls.create(id, { name: name.trim(), description, pinned: null, ts: Date.now() }));
    await this.c.flush();
    return id;
  }
  /** Private channel: an E2EE group where only admins post. Public channels use ChannelManager. */
  async createChannel(title: string, description = ''): Promise<string> {
    const { id } = await this.c.http<{ id: string }>('POST', '/v1/channels', { visibility: 'private' });
    await this.syncGroup(id);
    await this.setMeta(id, title, description);
    return id;
  }
  /** The member who makes a change closes the roster gap right away; the others would only race them. */
  private reconcileNow(gid: string) { return this.locked(() => this.mls.reconcile(gid)); }
  async addMember(gid: string, accountId: string) { await this.c.http('POST', `/v1/groups/${gid}/members`, { accountId }); await this.syncGroup(gid); await this.reconcileNow(gid); await this.c.flush(); }
  async addByUsername(gid: string, username: string) { const { accountId } = await this.c.lookupUsername(username.replace(/^@/, '')); await this.addMember(gid, accountId); }
  async removeMember(gid: string, accountId: string) { await this.c.http('DELETE', `/v1/groups/${gid}/members/${accountId}`); await this.syncGroup(gid); await this.reconcileNow(gid); await this.c.flush(); }
  async setRole(gid: string, accountId: string, role: 'admin' | 'member') { await this.c.http('PUT', `/v1/groups/${gid}/members/${accountId}/role`, { role }); await this.syncGroup(gid); }
  async transfer(gid: string, accountId: string) { await this.c.http('POST', `/v1/groups/${gid}/transfer`, { accountId }); await this.syncGroup(gid); }
  async leave(gid: string) { await this.c.http('POST', `/v1/groups/${gid}/leave`); this.mls.forget(gid); const g = this.c.groups.get(gid); if (g) { g.removed = true; this.touch(); } }
  async deleteGroup(gid: string) { await this.c.http('DELETE', `/v1/groups/${gid}`); this.mls.forget(gid); const g = this.c.groups.get(gid); if (g) { g.removed = true; this.touch(); } }
  async createInvite(gid: string, opts: { maxUses?: number; ttlHours?: number } = {}) {
    const { token } = await this.c.http<{ token: string }>('POST', `/v1/groups/${gid}/invites`, opts);
    return `${this.c.baseUrl}/#join=${gid}.${token}`;
  }
  async revokeInvites(gid: string) { await this.c.http('DELETE', `/v1/groups/${gid}/invites`); }
  async join(link: string): Promise<string> {
    const m = /join=([0-9a-f-]{36})\.([A-Za-z0-9_-]+)/.exec(link);
    if (!m) throw new Error('not an invite link');
    await this.c.http('POST', `/v1/groups/${m[1]}/join`, { token: m[2] });
    await this.syncGroup(m[1]!);
    return m[1]!;
  }
  /** Look up usernames for members (lazy, cached by the client). */
  async resolveMembers(gid: string) {
    for (const m of this.c.groups.get(gid)?.members ?? []) await this.c.resolveContact(m.accountId).catch(() => {});
  }
}
