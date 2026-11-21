// Pairwise end-to-end encryption on the official libsignal (Signal's Rust implementation, native build for Node/Electron):
// PQXDH key agreement (X25519 + Kyber/ML-KEM) and the Double Ratchet. This replaces our own X3DH composition.
// AGPL-3.0-only, because libsignal is. The engine runs in a Node process (the Electron main process, or tests);
// the sandboxed interface talks to it over a narrow bridge and never holds ratchet or identity keys itself.
import * as sig from '@signalapp/libsignal-client';
import type { SignalProvider, RemoteBundle, Ciphertext, PrekeyWire, SignedPrekeyWire } from '@vanishgram/client-core';
export type { SignalProvider, RemoteBundle, Ciphertext, PrekeyWire, SignedPrekeyWire };

type B = Uint8Array;
const b64 = (u: B) => Buffer.from(u).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const toBuf = (u: B) => Buffer.from(u);

/** A peer device, as `<accountId>:<deviceId>`. libsignal wants a numeric device id; we use 1 and put the real one in the name. */
const addr = (name: string) => sig.ProtocolAddress.new(name, 1);

interface Snapshot {
  v: 1; identity: string; regId: number; spkId: number; kyberId: number; nextOpk: number;
  spk: Record<string, string>; kyber: Record<string, string>; opk: Record<string, string>;
  sessions: Record<string, string>; trusted: Record<string, string>; usedKyber: string[];
}

const KEEP_OLD = 3;

export class SignalEngine implements SignalProvider {
  private chain: Promise<unknown> = Promise.resolve();
  /** One engine operation at a time. A session is loaded, changed and stored back across awaits, so overlapping calls would lose updates. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  identity!: sig.PrivateKey;
  regId = 0;
  spkId = 0; private kyberId = 0; private nextOpk = 1;
  spk = new Map<number, sig.SignedPreKeyRecord>();
  kyber = new Map<number, sig.KyberPreKeyRecord>();
  opk = new Map<number, sig.PreKeyRecord>();
  sessions = new Map<string, sig.SessionRecord>();
  trusted = new Map<string, B>();
  usedKyber = new Set<string>();
  selfAddr = sig.ProtocolAddress.new('self', 1);

  // ---- libsignal store callbacks, backed by the maps above ----
  private sessionStore = new (class extends sig.SessionStore {
    e: SignalEngine; constructor(e: SignalEngine) { super(); this.e = e; }
    async saveSession(a: sig.ProtocolAddress, r: sig.SessionRecord) { this.e.sessions.set(a.name(), r); }
    async getSession(a: sig.ProtocolAddress) { return this.e.sessions.get(a.name()) ?? null; }
    async getExistingSessions(as: sig.ProtocolAddress[]) { return as.map((a) => { const s = this.e.sessions.get(a.name()); if (!s) throw new Error('no session'); return s; }); }
  })(this);
  private identityStore = new (class extends sig.IdentityKeyStore {
    e: SignalEngine; constructor(e: SignalEngine) { super(); this.e = e; }
    async getIdentityKey() { return this.e.identity; }
    async getLocalRegistrationId() { return this.e.regId; }
    async saveIdentity(a: sig.ProtocolAddress, k: sig.PublicKey) { const had = this.e.trusted.get(a.name()); this.e.trusted.set(a.name(), k.serialize()); return had && !Buffer.from(had).equals(toBuf(k.serialize())) ? sig.IdentityChange.ReplacedExisting : sig.IdentityChange.NewOrUnchanged; }
    // Only a key that the caller has already checked against the account certificate is trusted.
    async isTrustedIdentity(a: sig.ProtocolAddress, k: sig.PublicKey) { const t = this.e.trusted.get(a.name()); return !!t && Buffer.from(t).equals(toBuf(k.serialize())); }
    async getIdentity(a: sig.ProtocolAddress) { const t = this.e.trusted.get(a.name()); return t ? sig.PublicKey.deserialize(toBuf(t)) : null; }
  })(this);
  private preKeyStore = new (class extends sig.PreKeyStore {
    e: SignalEngine; constructor(e: SignalEngine) { super(); this.e = e; }
    async savePreKey(id: number, r: sig.PreKeyRecord) { this.e.opk.set(id, r); }
    async getPreKey(id: number) { const r = this.e.opk.get(id); if (!r) throw new Error('unknown one-time prekey'); return r; }
    async removePreKey(id: number) { this.e.opk.delete(id); } // one-time means one-time
  })(this);
  private signedStore = new (class extends sig.SignedPreKeyStore {
    e: SignalEngine; constructor(e: SignalEngine) { super(); this.e = e; }
    async saveSignedPreKey(id: number, r: sig.SignedPreKeyRecord) { this.e.spk.set(id, r); }
    async getSignedPreKey(id: number) { const r = this.e.spk.get(id); if (!r) throw new Error('unknown signed prekey'); return r; }
  })(this);
  private kyberStore = new (class extends sig.KyberPreKeyStore {
    e: SignalEngine; constructor(e: SignalEngine) { super(); this.e = e; }
    async saveKyberPreKey(id: number, r: sig.KyberPreKeyRecord) { this.e.kyber.set(id, r); }
    async getKyberPreKey(id: number) { const r = this.e.kyber.get(id); if (!r) throw new Error('unknown kyber prekey'); return r; }
    async markKyberPreKeyUsed(id: number, spkId: number, base: sig.PublicKey) {
      // Last-resort Kyber keys may be reused, but the exact (key, base key) pair must never repeat: that would be a replay.
      const tag = `${id}:${spkId}:${b64(base.serialize())}`;
      if (this.e.usedKyber.has(tag)) throw new Error('replayed first message');
      this.e.usedKyber.add(tag);
    }
  })(this);

  async create() {
    this.identity = sig.PrivateKey.generate();
    this.regId = 1 + Math.floor(Math.random() * 0x3ffe); // 14 bits, as in libsignal
    this.spk.clear(); this.kyber.clear(); this.opk.clear(); this.sessions.clear(); this.trusted.clear(); this.usedKyber.clear();
    this.spkId = 0; this.kyberId = 0; this.nextOpk = 1;
    await this._rotatePrekeys();
  }

  private async _rotatePrekeys() {
    const now = Date.now();
    const sk = sig.PrivateKey.generate(); const sid = ++this.spkId;
    this.spk.set(sid, sig.SignedPreKeyRecord.new(sid, now, sk.getPublicKey(), sk, toBuf(this.identity.sign(toBuf(sk.getPublicKey().serialize())))));
    const kp = sig.KEMKeyPair.generate(); const kid = ++this.kyberId;
    this.kyber.set(kid, sig.KyberPreKeyRecord.new(kid, now, kp, toBuf(this.identity.sign(toBuf(kp.getPublicKey().serialize())))));
    for (const m of [this.spk, this.kyber]) { const ids = [...m.keys()].sort((a, b) => b - a); for (const old of ids.slice(KEEP_OLD)) m.delete(old); }
  }

  private async _newOneTimePrekeys(count: number) {
    const out: PrekeyWire[] = [];
    for (let i = 0; i < count; i++) { const k = sig.PrivateKey.generate(); const id = this.nextOpk++; this.opk.set(id, sig.PreKeyRecord.new(id, k.getPublicKey(), k)); out.push({ id, pub: b64(k.getPublicKey().serialize()) }); }
    return out;
  }
  async oneTimePrekeyCount() { return this.opk.size; }
  async identityKey() { return b64(this.identity.getPublicKey().serialize()); }
  async registrationId() { return this.regId; }
  async signedPrekey(): Promise<SignedPrekeyWire> { const r = this.spk.get(this.spkId)!; return { id: r.id(), pub: b64(r.publicKey().serialize()), sig: b64(r.signature()) }; }
  async kyberPrekey(): Promise<SignedPrekeyWire> { const r = this.kyber.get(this.kyberId)!; return { id: r.id(), pub: b64(r.publicKey().serialize()), sig: b64(r.signature()) }; }

  async verify(identityKey: string, message: Uint8Array, signature: string) {
    try { return sig.PublicKey.deserialize(toBuf(unb64(identityKey))).verify(toBuf(message), toBuf(unb64(signature))); } catch { return false; }
  }
  private async _trust(peer: string, identityKey: string) {
    const had = this.trusted.get(peer); const now = unb64(identityKey);
    if (had && !Buffer.from(had).equals(toBuf(now))) { this.sessions.delete(peer); } // a changed key invalidates the old session
    this.trusted.set(peer, now);
  }
  async hasSession(peer: string) { return !!this.sessions.get(peer)?.hasCurrentState(); }
  async dropSession(peer: string) { this.sessions.delete(peer); this.trusted.delete(peer); }

  private async _processBundle(peer: string, remoteDeviceId: number, b: RemoteBundle) {
    const bundle = sig.PreKeyBundle.new(
      b.registrationId, remoteDeviceId,
      b.oneTimePrekey?.id ?? null, b.oneTimePrekey ? sig.PublicKey.deserialize(toBuf(unb64(b.oneTimePrekey.pub))) : null,
      b.signedPrekey.id, sig.PublicKey.deserialize(toBuf(unb64(b.signedPrekey.pub))), toBuf(unb64(b.signedPrekey.sig)),
      sig.PublicKey.deserialize(toBuf(unb64(b.identityKey))),
      b.kyberPrekey.id, sig.KEMPublicKey.deserialize(toBuf(unb64(b.kyberPrekey.pub))), toBuf(unb64(b.kyberPrekey.sig)));
    await sig.processPreKeyBundle(bundle, addr(peer), this.selfAddr, this.sessionStore, this.identityStore);
  }

  private async _encrypt(peer: string, plaintext: Uint8Array): Promise<Ciphertext> {
    const ct = await sig.signalEncrypt(toBuf(plaintext), addr(peer), this.selfAddr, this.sessionStore, this.identityStore);
    return { type: ct.type(), body: new Uint8Array(ct.serialize()) };
  }

  private async _decrypt(peer: string, ct: Ciphertext): Promise<Uint8Array> {
    const a = addr(peer);
    // Work on a copy of the session table so a forged or corrupted message cannot change state (libsignal also guards this).
    if (ct.type === sig.CiphertextMessageType.PreKey) {
      const m = sig.PreKeySignalMessage.deserialize(toBuf(ct.body));
      return new Uint8Array(await sig.signalDecryptPreKey(m, a, this.selfAddr, this.sessionStore, this.identityStore, this.preKeyStore, this.signedStore, this.kyberStore));
    }
    if (ct.type === sig.CiphertextMessageType.Whisper) {
      return new Uint8Array(await sig.signalDecrypt(sig.SignalMessage.deserialize(toBuf(ct.body)), a, this.selfAddr, this.sessionStore, this.identityStore));
    }
    throw new Error('unsupported message type');
  }

  // ---- persistence ----
  private async _save(): Promise<Uint8Array> {
    const rec = <T extends { serialize(): Uint8Array }>(m: Map<number | string, T>) => Object.fromEntries([...m].map(([k, v]) => [String(k), b64(v.serialize())]));
    const s: Snapshot = {
      v: 1, identity: b64(this.identity.serialize()), regId: this.regId, spkId: this.spkId, kyberId: this.kyberId, nextOpk: this.nextOpk,
      spk: rec(this.spk), kyber: rec(this.kyber), opk: rec(this.opk), sessions: rec(this.sessions),
      trusted: Object.fromEntries([...this.trusted].map(([k, v]) => [k, b64(v)])), usedKyber: [...this.usedKyber],
    };
    return new TextEncoder().encode(JSON.stringify(s));
  }

  private async _load(state: Uint8Array) {
    const s = JSON.parse(new TextDecoder().decode(state)) as Snapshot;
    if (s.v !== 1) throw new Error('unknown signal state version');
    this.identity = sig.PrivateKey.deserialize(toBuf(unb64(s.identity))); this.regId = s.regId; this.spkId = s.spkId; this.kyberId = s.kyberId; this.nextOpk = s.nextOpk;
    const fill = <T>(src: Record<string, string>, f: (b: Uint8Array<ArrayBuffer>) => T, key: (k: string) => number | string) => new Map<any, T>(Object.entries(src).map(([k, v]) => [key(k), f(toBuf(unb64(v)))]));
    this.spk = fill(s.spk, (b) => sig.SignedPreKeyRecord.deserialize(b), Number); this.kyber = fill(s.kyber, (b) => sig.KyberPreKeyRecord.deserialize(b), Number);
    this.opk = fill(s.opk, (b) => sig.PreKeyRecord.deserialize(b), Number); this.sessions = fill(s.sessions, (b) => sig.SessionRecord.deserialize(b), String);
    this.trusted = new Map(Object.entries(s.trusted).map(([k, v]) => [k, unb64(v)])); this.usedKyber = new Set(s.usedKyber);
  }
  processBundle(peer: string, remoteDeviceId: number, b: RemoteBundle) { return this.serial(() => this._processBundle(peer, remoteDeviceId, b)); }
  encrypt(peer: string, plaintext: Uint8Array) { return this.serial(() => this._encrypt(peer, plaintext)); }
  decrypt(peer: string, ct: Ciphertext) { return this.serial(() => this._decrypt(peer, ct)); }
  save() { return this.serial(() => this._save()); }
  load(state: Uint8Array) { return this.serial(() => this._load(state)); }
  rotatePrekeys() { return this.serial(() => this._rotatePrekeys()); }
  newOneTimePrekeys(count: number) { return this.serial(() => this._newOneTimePrekeys(count)); }
  trust(peer: string, identityKey: string) { return this.serial(() => this._trust(peer, identityKey)); }
}

export const createSignalEngine = (): SignalProvider => new SignalEngine();
