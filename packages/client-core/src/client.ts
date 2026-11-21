import { sha256 } from '@noble/hashes/sha2.js';
import type { Envelope, PrekeyBundleWire, WireMessage } from '@vanishgram/protocol';
import { b64, unb64, utf8, fromUtf8, hex, concat, pad, unpad } from './encoding.ts';
import { deriveAccount, newMnemonic, signLogin, type AccountKeys } from './account.ts';
import { createDevice, deviceToWire, topUpPrekeys, verifyBundle, type DeviceKeys } from './device.ts';
import { encodeState, decodeState } from './serialize.ts';
import { newSignalProvider } from './signal.ts';
import { newMlsSig } from './device.ts';
import type { StoredKeyPackage } from './mls-groups.ts';
import { createVaultKey, sealWithKey, openVault, DEFAULT_KDF, type KdfParams, type VaultBackend, type VaultKey } from './vault.ts';
import { GroupManager, type GroupState, type PendingGroupMsg } from './groups-client.ts';
import type { RecvChain } from './groupkeys.ts';
import { ChannelManager, type PublicChannel } from './channels-client.ts';
import { CallManager, type CallState } from './calls-client.ts';
import { ProfileManager } from './profile-client.ts';
import { FileManager, type PendingUpload } from './files-client.ts';
import type { FileInfo, ChatPrefs } from '@vanishgram/protocol';
import { ExtrasManager, emptyPrefs } from './extras-client.ts';
import { TwoFactorManager, opaqueLogin, type SecondFactorHook } from './twofa-client.ts';

interface Snapshot {
  /** v2: libsignal. v1 (our own ratchet) cannot be read any more: such a vault keeps its chats but gets a new device identity. */
  v: 1 | 2; account: AccountKeys; deviceId?: string; signal?: Uint8Array; rotatedAt?: number; token: string;
  mlsSig?: { priv: Uint8Array; pub: Uint8Array }; mlsPackages?: StoredKeyPackage[]; mlsGroups?: Map<string, Uint8Array>;
  senderCache: Map<string, PrekeyBundleWire>;
  chats: Map<string, ChatMessage[]>; tombstones: Set<string>;
  contacts?: Map<string, Contact>;
  groups?: Map<string, GroupState>; recvChains?: Map<string, RecvChain>; pendingGroup?: PendingGroupMsg[];
  channels?: Map<string, PublicChannel>; muted?: Set<string>; viewed?: Set<string>;
  receipted?: Set<string>; blockedSet?: Set<string>; pendingUploads?: Map<string, PendingUpload>;
  prefs?: ChatPrefs; drafts?: Map<string, string>; ttl?: Map<string, { seconds: number; ts: number }>;
}
export interface Contact { username?: string; displayName?: string; bio?: string; avatarVersion?: number }

export interface ChatMessage { id: string; from: string; body: string; ts: number; replyTo?: string; serverIds: string[]; seq?: number; views?: number; edited?: boolean; sys?: boolean; read?: boolean; file?: FileInfo; fwd?: string; reactions?: Record<string, string>; exp?: number; delivered?: boolean }

function leadingZeroBits(h: Uint8Array): number {
  let z = 0;
  for (const byte of h) { if (byte === 0) { z += 8; continue; } z += Math.clz32(byte) - 24; break; }
  return z;
}
function solvePow(challenge: string, bits: number): string {
  for (let n = 0; ; n++) if (leadingZeroBits(sha256(utf8(`${challenge}:${n}`))) >= bits) return String(n);
}

/**
 * Headless client: everything except rendering. State is in memory only; persistent
 * encrypted storage (IndexedDB/SQLCipher) is NOT implemented yet.
 */
export class VanishClient {
  /** Coarse name this device shows in the device list, set by the app (for example "Chrome on Windows"). */
  static deviceLabel = '';
  readonly account: AccountKeys;
  readonly device: DeviceKeys;
  readonly baseUrl: string;
  token = '';
  /** chats keyed by peer account id */
  chats = new Map<string, ChatMessage[]>();
  tombstones = new Set<string>();
  onMessage: (peer: string, m: ChatMessage) => void = () => {};
  onChange: () => void = () => {};
  onError: (e: unknown) => void = () => {};
  onDisconnect: () => void = () => {};
  /** The server no longer accepts this device's session (signed out from another device, or banned). */
  onSessionLost: (reason: 'revoked' | 'expired') => void = () => {};
  private armed = false;
  private rotatedAt = Date.now();
  private needsRegister = false;
  private senderCache = new Map<string, PrekeyBundleWire>();
  private ws: WebSocket | null = null;
  private queue: Promise<void> = Promise.resolve();
  // ---- group state (see groups-client.ts); chat id of a group is "g:<groupId>" ----
  groups = new Map<string, GroupState>();
  recvChains = new Map<string, RecvChain>();
  pendingGroup: PendingGroupMsg[] = [];
  readonly gm: GroupManager;
  // ---- public channels (chat id "c:<id>"), mute list, posts already counted as viewed ----
  channels = new Map<string, PublicChannel>();
  muted = new Set<string>();
  viewed = new Set<string>();
  readonly ch: ChannelManager;
  readonly calls: CallManager;
  readonly profile: ProfileManager;
  readonly files: FileManager;
  readonly x: ExtrasManager;
  prefs: ChatPrefs = emptyPrefs();
  drafts = new Map<string, string>();
  ttl = new Map<string, { seconds: number; ts: number }>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  pendingUploads = new Map<string, PendingUpload>();
  readonly tf: TwoFactorManager;
  /** ids of incoming messages I already sent a read receipt for, and accounts I blocked */
  receipted = new Set<string>();
  blockedSet = new Set<string>();
  onTyping: (peer: string) => void = () => {};
  onCall: (s: CallState | null) => void = () => {};

  /** peer account id -> display info (usernames are public directory data) */
  contacts = new Map<string, Contact>();
  private vault: { backend: VaultBackend; vk: VaultKey } | null = null;
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;

  private constructor(baseUrl: string, account: AccountKeys, device: DeviceKeys) {
    this.baseUrl = baseUrl; this.account = account; this.device = device;
    this.gm = new GroupManager(this);
    this.ch = new ChannelManager(this);
    this.calls = new CallManager(this);
    this.profile = new ProfileManager(this);
    this.files = new FileManager(this);
    this.x = new ExtrasManager(this);
    this.tf = new TwoFactorManager(this);
  }

  // ---------- encrypted persistence ----------
  /** Start saving every state change to an encrypted vault. Fails if the passphrase is weak. */
  async attachVault(backend: VaultBackend, pass: string, params: KdfParams = DEFAULT_KDF) {
    this.vault = { backend, vk: await createVaultKey(pass, params) };
    this.dirty = true;
    await this.flush();
  }

  private soon: ReturnType<typeof setTimeout> | null = null;
  /** Save shortly (batched). For UI-level changes; anything a crash must not lose (ratchets, acks) uses flush(). */
  flushSoon() { if (!this.vault || this.soon) return; this.soon = setTimeout(() => { this.soon = null; void this.flush().catch((e) => this.onError(e)); }, 1500); }

  /** Resolves once everything changed so far is on disk. */
  flush(): Promise<void> {
    if (!this.vault) return Promise.resolve();
    this.dirty = true;
    this.saving = this.saving.then(async () => {
      if (!this.dirty || !this.vault) return;
      this.dirty = false;
      const snap: Snapshot = {
        v: 2, account: this.account, deviceId: this.device.deviceId, signal: await this.device.signal.save(), rotatedAt: this.rotatedAt, token: this.token,
        mlsSig: this.device.mlsSig, mlsPackages: this.gm.mls.packages, mlsGroups: this.gm.mls.exportStates(),
        senderCache: this.senderCache, chats: this.chats, tombstones: this.tombstones,
        contacts: this.contacts, groups: this.groups, recvChains: this.recvChains, pendingGroup: this.pendingGroup,
        channels: this.channels, muted: this.muted, viewed: this.viewed, receipted: this.receipted, blockedSet: this.blockedSet, pendingUploads: this.pendingUploads, prefs: this.prefs, drafts: this.drafts, ttl: this.ttl,
      };
      const { backend, vk } = this.vault;
      await backend.write(sealWithKey(vk, this.account.accountId, utf8(encodeState(snap))));
    });
    return this.saving;
  }

  /** Change the vault passphrase (re-encrypts under a fresh salt). */
  async changePassphrase(newPass: string) {
    if (!this.vault) throw new Error('no vault attached');
    this.vault.vk = await createVaultKey(newPass, this.vault.vk.params); await this.flush();
  }

  /** Restore a client from its vault and re-authenticate with the stored account key. */
  static async open(baseUrl: string, backend: VaultBackend, pass: string, hook?: SecondFactorHook): Promise<VanishClient | null> {
    const file = await backend.read();
    if (!file) return null;
    const { plaintext, vaultKey } = await openVault(pass, file);
    const snap = decodeState<Snapshot>(fromUtf8(plaintext));
    if (snap.v !== 1 && snap.v !== 2) throw new Error('unsupported state version');
    let device: DeviceKeys, migrated = false;
    if (snap.v === 2 && snap.signal && snap.deviceId) { const signal = newSignalProvider(); await signal.load(snap.signal); device = { deviceId: snap.deviceId, signal, mlsSig: snap.mlsSig ?? newMlsSig() }; if (!snap.mlsSig) migrated = true; }
    else { device = await createDevice(); migrated = true; } // older vaults used our own ratchet: keep the chats, start fresh keys
    const c = new VanishClient(baseUrl, snap.account, device);
    c.needsRegister = migrated; c.rotatedAt = snap.rotatedAt ?? Date.now();
    c.gm.mls.packages = snap.mlsPackages ?? []; c.gm.mls.importStates(snap.mlsGroups ?? new Map());
    c.token = snap.token; c.senderCache = migrated ? new Map() : snap.senderCache;
    c.groups = snap.groups ?? new Map(); c.recvChains = snap.recvChains ?? new Map(); c.pendingGroup = snap.pendingGroup ?? [];
    c.channels = snap.channels ?? new Map(); c.muted = snap.muted ?? new Set(); c.viewed = snap.viewed ?? new Set();
    c.receipted = snap.receipted ?? new Set(); c.blockedSet = snap.blockedSet ?? new Set(); c.pendingUploads = snap.pendingUploads ?? new Map();
    c.prefs = snap.prefs ?? emptyPrefs(); c.drafts = snap.drafts ?? new Map(); c.ttl = snap.ttl ?? new Map();
    c.chats = snap.chats; c.tombstones = snap.tombstones;
    c.vault = { backend, vk: vaultKey };
    c.contacts = snap.contacts ?? new Map();
    // Reuse the stored session when it is still valid, so two-step verification is only asked for on a NEW sign-in.
    try { await c.http('GET', '/v1/session'); } catch (e) { if ((e as any)?.status === 401) await c.login(hook); else throw e; }
    if (c.needsRegister) { await c.http('PUT', '/v1/devices', await deviceToWire(c.account, c.device, await topUpPrekeys(c.device, 20), VanishClient.deviceLabel)); c.needsRegister = false; }
    await c.maintainPrekeys();
    await c.gm.mls.maintainKeyPackages();
    await c.flush();
    c.armed = true;
    return c;
  }

  /** Keep enough one-time prekeys on the server, and rotate the signed and post-quantum prekeys weekly. */
  private async maintainPrekeys() {
    if (Date.now() - this.rotatedAt > 7 * 86400_000) {
      await this.device.signal.rotatePrekeys();
      this.rotatedAt = Date.now();
      await this.http('PUT', '/v1/devices', await deviceToWire(this.account, this.device, await topUpPrekeys(this.device, 20), VanishClient.deviceLabel));
    } else {
      const { remaining } = await this.http<{ remaining: number }>('POST', '/v1/prekeys', { oneTimePrekeys: [] });
      if (remaining < 10) await this.http('POST', '/v1/prekeys', { oneTimePrekeys: await topUpPrekeys(this.device, 20) });
    }
  }

  /** Remove local data (logout of this device). Server-side session is revoked too. */
  async wipe() {
    await this.http('DELETE', '/v1/devices/me').catch(() => {}); // the device and its queued mail go away server-side too
    await this.http('POST', '/v1/auth/logout', {}).catch(() => {});
    await this.vault?.backend.remove(); this.vault = null; this.close();
  }

  /** Returns the client and the phrase, which the UI must show the user exactly once. */
  static async register(baseUrl: string, mnemonic: string = newMnemonic()): Promise<{ client: VanishClient; mnemonic: string }> {
    const account = deriveAccount(mnemonic);
    const c = new VanishClient(baseUrl, account, await createDevice());
    const pow = await c.http<{ challenge: string; bits: number }>('GET', '/v1/pow');
    await c.http('POST', '/v1/register', {
      authPublicKey: b64(account.authPublicKey), pow: { challenge: pow.challenge, nonce: solvePow(pow.challenge, pow.bits) },
    });
    await c.signIn();
    return { client: c, mnemonic };
  }

  /** Recovery / new-device login: the phrase stays local, only a signature is sent. */
  static async recover(baseUrl: string, mnemonic: string, hook?: SecondFactorHook): Promise<VanishClient> {
    const c = new VanishClient(baseUrl, deriveAccount(mnemonic), await createDevice());
    await c.signIn(hook);
    return c;
  }

  private async signIn(hook?: SecondFactorHook) {
    await this.login(hook);
    await this.http('PUT', '/v1/devices', await deviceToWire(this.account, this.device, await topUpPrekeys(this.device, 20), VanishClient.deviceLabel));
    await this.gm.mls.maintainKeyPackages();
    this.armed = true;
  }

  private async login(hook?: SecondFactorHook) {
    const { nonce } = await this.http<{ nonce: string }>('POST', '/v1/auth/challenge', { accountId: this.account.accountId });
    const r = await this.http<any>('POST', '/v1/auth/login', {
      accountId: this.account.accountId, nonce, deviceId: this.device.deviceId, signature: b64(signLogin(this.account, nonce)),
    });
    if (r.token) { this.token = r.token; return; }
    // Two-step verification is on: the phrase alone does not give a session.
    if (!hook) throw Object.assign(new Error('two-step verification required'), { status: 401, code: 'second-factor' });
    for (let attempt = 0; attempt < 5; attempt++) {
      const ans = await hook({ totp: !!r.factors.totp, password: !!r.factors.password, attempt });
      if (!ans) throw Object.assign(new Error('sign-in cancelled'), { code: 'cancelled' });
      const body: Record<string, unknown> = { ticket: r.pending, totp: ans.totp, recovery: ans.recovery };
      if (r.factors.password) {
        // A wrong password is noticed on this device: send nothing usable and let the server say no, like any other wrong answer.
        const o = await opaqueLogin(this, '/v1/auth/2fa/opaque', { ticket: r.pending }, ans.password ?? '');
        if (o) body.opaque = o;
      }
      try { this.token = (await this.http<{ token: string }>('POST', '/v1/auth/2fa', body)).token; return; }
      catch (e) { if ((e as any)?.status !== 401) throw e; }
    }
    throw Object.assign(new Error('too many wrong attempts'), { status: 429 });
  }

  async http<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method, headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await res.json();
    if (res.status === 401 && this.armed && !path.startsWith('/v1/auth')) { this.armed = false; this.onSessionLost('revoked'); }
    if (!res.ok) throw Object.assign(new Error(j.error ?? 'request failed'), { status: res.status });
    return j as T;
  }

  // ---------- connection ----------
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Token goes in the subprotocol header, never in the URL.
      const ws = new WebSocket(this.baseUrl.replace(/^http/, 'ws') + '/v1/ws', this.token);
      this.ws = ws;
      ws.onopen = () => { if (!this.sweepTimer) { this.sweepTimer = setInterval(() => this.x.sweep(), 5000); (this.sweepTimer as any).unref?.(); } resolve(); };
      ws.onerror = () => reject(new Error('websocket failed'));
      ws.onclose = (ev) => { if (ev.code === 4002 && this.armed) { this.armed = false; this.close(); this.onSessionLost('revoked'); } else if (this.ws === ws) this.onDisconnect(); };
      ws.onmessage = (ev) => {
        const f = JSON.parse(String(ev.data));
        if (f.type === 'message') this.queue = this.queue.then(() => f.message.group ? this.gm.receiveGroup(f.message) : this.receive(f.message)).catch((e) => this.onError(e));
        else if (f.type === 'group-event') this.queue = this.queue.then(() => this.gm.onEvent(f)).catch((e) => this.onError(e));
        else if (typeof f.type === 'string' && f.type.startsWith('channel-')) this.ch.onFrame(f);
        else if (f.type === 'delivered' && typeof f.id === 'string') this.markDelivered(f.id);
        else if (f.type === 'typing' && typeof f.from === 'string' && !this.blockedSet.has(f.from)) this.onTyping(f.from);
      };
      ws.addEventListener('open', () => { this.queue = this.queue.then(() => this.gm.syncAll()).catch((e) => this.onError(e)); });
    });
  }
  /** The recipient's device confirmed receipt of this queued message (server tells us; it learns nothing new). */
  private markDelivered(serverId: string) {
    for (const list of this.chats.values()) for (const m of list) if (!m.delivered && m.serverIds.includes(serverId)) { m.delivered = true; this.onChange(); this.flushSoon(); return; }
  }
  get connected(): boolean { return this.ws?.readyState === 1; }
  close() { const w = this.ws; this.ws = null; w?.close(); if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; } }
  sendFrame(f: unknown) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(f)); }
  /** Tell the server a queued row has been durably processed (it deletes its copy). */
  ack(id: string) { this.ws?.send(JSON.stringify({ type: 'ack', id })); }

  // ---------- sending ----------
  async peerBundles(accountId: string): Promise<PrekeyBundleWire[]> {
    const { devices } = await this.http<{ devices: PrekeyBundleWire[] }>('GET', `/v1/accounts/${accountId}/devices`);
    await Promise.all(devices.map((d) => verifyBundle(d, accountId, this.device.signal)));
    return devices;
  }

  private async encryptFor(accountId: string, env: Envelope, onlyDevice?: string): Promise<{ toDevice: string; body: string }[]> {
    const out: { toDevice: string; body: string }[] = [];
    const signal = this.device.signal;
    for (const dev of await this.peerBundles(accountId)) {
      if (accountId === this.account.accountId && dev.deviceId === this.device.deviceId) continue;
      if (onlyDevice && dev.deviceId !== onlyDevice) continue;
      const peer = `${accountId}:${dev.deviceId}`;
      await signal.trust(peer, dev.identityKey); // the identity key is certified by the account key (verified above)
      if (!(await signal.hasSession(peer))) {
        const { devices } = await this.http<{ devices: PrekeyBundleWire[] }>('GET', `/v1/accounts/${accountId}/prekeys`);
        const fresh = devices.find((d) => d.deviceId === dev.deviceId)!;
        await verifyBundle(fresh, accountId, signal);
        if (fresh.identityKey !== dev.identityKey) throw new Error('device identity changed during key fetch');
        await signal.processBundle(peer, 1, { registrationId: fresh.registrationId, identityKey: fresh.identityKey, signedPrekey: fresh.signedPrekey, kyberPrekey: fresh.kyberPrekey, ...(fresh.oneTimePrekey ? { oneTimePrekey: fresh.oneTimePrekey } : {}) });
      }
      const ct = await signal.encrypt(peer, pad(utf8(JSON.stringify(env))));
      out.push({ toDevice: dev.deviceId, body: b64(concat(Uint8Array.of(ct.type), ct.body)) });
    }
    return out;
  }

  async deliver(accountId: string, env: Envelope, onlyDevice?: string): Promise<string[]> {
    const ids: string[] = [];
    const encrypted = await this.encryptFor(accountId, env, onlyDevice);
    await this.flush(); // ratchet advanced: persist before the message can leave the device
    for (const m of encrypted) {
      const r = await this.http<{ id: string }>('POST', '/v1/messages', { toAccount: accountId, toDevice: m.toDevice, body: m.body });
      ids.push(r.id);
    }
    return ids;
  }

  async sendText(to: string, body: string, replyTo?: string, fwd?: string): Promise<ChatMessage> {
    if ([...body].length > 4096) throw new Error('message too long');
    const id = hex(crypto.getRandomValues(new Uint8Array(12)));
    const env: Envelope = { t: 'text', id, body, ts: Date.now(), ...(replyTo ? { replyTo } : {}), ...(fwd ? { fwd } : {}) };
    const serverIds = await this.deliver(to, env);
    return this.store(to, { id, from: this.account.accountId, body, ts: env.ts, replyTo, serverIds, ...(fwd ? { fwd } : {}) });
  }

  /** Delete for me: local removal + encrypted sync to my other devices. The peer's copy stays. */
  async deleteForMe(peer: string, id: string) {
    this.remove(peer, id);
    await this.deliver(this.account.accountId, { t: 'delete-for-me-sync', target: id, peer, ts: Date.now() });
  }

  /** Delete for everyone: tombstone, purge still-queued ciphertext, send encrypted delete event. */
  async deleteForEveryone(peer: string, id: string) {
    const msg = this.chats.get(peer)?.find((m) => m.id === id);
    this.tombstones.add(id);
    this.remove(peer, id);
    if (msg?.file && msg.from === this.account.accountId) await this.files.removeForEveryone(msg.file.fileId);
    if (msg) for (const sid of msg.serverIds) await this.http('DELETE', `/v1/messages/${sid}`).catch(() => {});
    await this.deliver(peer, { t: 'delete-everyone', target: id, ts: Date.now() });
  }

  // ---------- receiving ----------
  private async receive(w: WireMessage) {
    try {
      const msg = unb64(w.body);
      const key = `${w.from}:${w.fromDevice}`;
      let sender = this.senderCache.get(key);
      if (!sender) {
        sender = (await this.peerBundles(w.from)).find((d) => d.deviceId === w.fromDevice);
        if (!sender) throw new Error('unknown sender device');
        this.senderCache.set(key, sender);
      }
      const peer = key;
      await this.device.signal.trust(peer, sender.identityKey); // only the identity certified by the sender's account key is accepted
      if (msg.length < 2) throw new Error('truncated message');
      const plaintext = unpad(await this.device.signal.decrypt(peer, { type: msg[0]!, body: msg.slice(1) }));
      await this.handle(w.from, w.fromDevice, JSON.parse(fromUtf8(plaintext)) as Envelope, w.id);
      void this.resolveContact(w.from).catch(() => {});
      await this.flush(); // never ack (server deletes its copy) before the new state is durable
    } catch (e) {
      this.onError(e);
    } finally {
      // ack even on failure: a poisoned message must not block the queue forever
      this.ack(w.id);
    }
  }

  private async handle(from: string, fromDevice: string, env: Envelope, serverId: string) {
    if (env.t === 'edit' || env.t === 'react' || env.t === 'ttl' || env.t === 'prefs') { this.x.onEnvelope(from === this.account.accountId ? (env as any).chat ?? from : from, from, env); return; }
    if (env.t === 'read') {
      const mine = this.chats.get(from);
      if (mine) { for (const m of mine) if (env.ids.includes(m.id) && m.from === this.account.accountId) m.read = true; this.onChange(); this.flushSoon(); }
      return;
    }
    if (env.t.startsWith('call-')) { await this.calls.onSignal(from, fromDevice, env as any); return; }
    if (env.t === 'sender-key' || env.t === 'group-meta') { await this.gm.onPairwise(from, fromDevice, env); return; }
    if (env.t === 'file') {
      if (this.tombstones.has(env.id)) return;
      const m = this.store(from, { id: env.id, from, body: env.body ?? '', ts: env.ts, replyTo: env.replyTo, serverIds: [serverId], file: env.file, ...(env.fwd ? { fwd: env.fwd } : {}) });
      this.onMessage(from, m);
      return;
    }
    if (env.t === 'text') {
      if (this.tombstones.has(env.id)) return; // the delete event arrived first
      const m = this.store(from, { id: env.id, from, body: env.body, ts: env.ts, replyTo: env.replyTo, serverIds: [serverId], ...(env.fwd ? { fwd: env.fwd } : {}) });
      this.onMessage(from, m);
    } else if (env.t === 'delete-everyone') {
      // A peer may only delete messages that the peer itself sent.
      const target = this.chats.get(from)?.find((m) => m.id === env.target);
      if (!target || target.from === from) { this.tombstones.add(env.target); this.remove(from, env.target); }
    } else if (env.t === 'delete-for-me-sync' && from === this.account.accountId) {
      this.remove(env.peer, env.target);
    }
  }

  store(peer: string, m: ChatMessage): ChatMessage {
    const list = this.chats.get(peer) ?? [];
    this.x.stamp(peer, m);
    if (m.from !== this.account.accountId && this.prefs.archived.includes(peer) && !this.muted.has(peer)) this.prefs.archived = this.prefs.archived.filter((x) => x !== peer); // new mail brings a chat back
    if (!list.some((x) => x.id === m.id)) list.push(m);
    this.chats.set(peer, list); this.onChange(); this.flushSoon();
    return m;
  }
  remove(peer: string, id: string) {
    const gone = this.chats.get(peer)?.find((m) => m.id === id);
    if (gone?.file) void this.files.release(gone.file.fileId);
    this.chats.set(peer, (this.chats.get(peer) ?? []).filter((m) => m.id !== id)); this.onChange(); this.flushSoon();
  }

  // ---------- directory ----------
  async resolveContact(id: string, force = false): Promise<Contact> {
    const known = this.contacts.get(id);
    if (known?.username && !force) return known;
    const p = await this.http<{ username: string | null; displayName?: string; bio?: string; avatarVersion?: number }>('GET', `/v1/accounts/${id}/profile`);
    const c: Contact = { username: p.username ?? undefined, displayName: p.displayName || undefined, bio: p.bio || undefined, avatarVersion: p.avatarVersion || 0 };
    this.contacts.set(id, c); this.onChange(); this.flushSoon();
    return c;
  }

  /** Find an account by @username and open an (empty) chat with it. */
  async startChat(username: string): Promise<string> {
    const { accountId } = await this.lookupUsername(username.replace(/^@/, ''));
    await this.resolveContact(accountId);
    if (!this.chats.has(accountId)) { this.chats.set(accountId, []); this.onChange(); this.flushSoon(); }
    return accountId;
  }

  async setUsername(name: string, primary = false) { return this.http('PUT', '/v1/usernames', { name, primary }); }
  async lookupUsername(name: string) { return this.http<{ accountId: string }>('GET', `/v1/usernames/${encodeURIComponent(name)}`); }
}
