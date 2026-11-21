// MLS groups on top of the server roster. The server decides WHO belongs to a group (and enforces roles); MLS decides what
// they can READ. Any member's device that notices a difference between the two (someone joined, was removed, signed in on a
// new device, signed a device out) builds a commit to close the gap. The server accepts exactly one commit per epoch, so a
// race between two members is settled there and the loser simply rebuilds on top of the winner's commit.
import type { ClientState } from 'ts-mls';
import type { PrekeyBundleWire, WireMessage, Envelope, KeyPackageClaim } from '@vanishgram/protocol';
import { b64, unb64, utf8, fromUtf8, equal } from './encoding.ts';
import * as M from './mls.ts';
import type { VanishClient } from './client.ts';
import type { GroupState } from './groups-client.ts';

export interface StoredKeyPackage { pub: Uint8Array; priv: { i: string; h: string; s: string }; lastResort: boolean }

/** What MlsGroups needs from the group manager (kept as callbacks so the two files do not import each other). */
export interface MlsHost {
  group(gid: string): GroupState | undefined;
  isAdmin(g: GroupState, account: string): boolean;
  /** Re-read the roster from the server. Must not take the manager's lock (the caller already holds it). */
  refresh(gid: string, force?: boolean): Promise<void>;
  deliverEnvelope(g: GroupState, from: string, env: Envelope, w: WireMessage): void;
  applyMeta(g: GroupState, m: M.GroupMeta): void;
  /** Queue work under the manager's lock. */
  later(fn: () => Promise<void>, ms: number): void;
  touch(): void;
}

export class MlsGroups {
  c: VanishClient;
  host: MlsHost;
  states = new Map<string, ClientState>();
  packages: StoredKeyPackage[] = [];
  private encoded = new Map<string, Uint8Array>();
  private dirty = new Set<string>();
  private bundleCache = new Map<string, { at: number; list: PrekeyBundleWire[] }>();
  private asked = new Map<string, number>();
  /** devices that told the group they lost their keys: removed and added again in the next commit */
  private resync = new Map<string, Set<string>>();
  readonly cfg: ReturnType<typeof M.clientConfig>;

  constructor(c: VanishClient, host: MlsHost) {
    this.c = c; this.host = host;
    // a credential is valid only if its signature key is the one the account certified for that device
    this.cfg = M.clientConfig(async (account, device, sigPub) => {
      // a device that signed in a moment ago is not in the cached list: look again before refusing it
      let b = (await this.bundles(account).catch(() => [])).find((x) => x.deviceId === device);
      if (!b) b = (await this.bundles(account, true).catch(() => [])).find((x) => x.deviceId === device);
      return !!b && equal(unb64(b.mlsKey), sigPub);
    });
  }

  private async bundles(account: string, fresh = false): Promise<PrekeyBundleWire[]> {
    const hit = this.bundleCache.get(account);
    if (hit && !fresh && Date.now() - hit.at < 15_000) return hit.list;
    const list = await this.c.peerBundles(account);
    this.bundleCache.set(account, { at: Date.now(), list });
    return list;
  }

  // ---------- persistence ----------
  /** Group states as bytes for the vault. Only groups that changed are re-encoded. */
  exportStates(): Map<string, Uint8Array> {
    for (const gid of this.dirty) { const s = this.states.get(gid); if (s) this.encoded.set(gid, M.saveState(s)); }
    this.dirty.clear();
    for (const gid of [...this.encoded.keys()]) if (!this.states.has(gid)) this.encoded.delete(gid);
    return new Map(this.encoded);
  }
  importStates(m: Map<string, Uint8Array>) {
    for (const [gid, bytes] of m) { try { this.states.set(gid, M.loadState(bytes, this.cfg)); this.encoded.set(gid, bytes); } catch (e) { this.c.onError(e); } }
  }
  private adopt(gid: string, s: ClientState) { this.states.set(gid, s); this.dirty.add(gid); }
  has(gid: string) { return this.states.has(gid); }
  forget(gid: string) { this.states.delete(gid); this.encoded.delete(gid); this.dirty.delete(gid); }

  // ---------- key packages: the invitations this device leaves on the server ----------
  async maintainKeyPackages() {
    const c = this.c;
    const info = await c.http<{ remaining: number; lastResort: boolean }>('GET', '/v1/keypackages/count');
    const make = async (lastResort: boolean) => {
      const kp = await M.newKeyPackage(c.device.mlsSig, c.account.accountId, c.device.deviceId);
      this.packages.push({ pub: kp.publicBytes, priv: M.encodePrivate(kp.priv), lastResort });
      return b64(kp.publicBytes);
    };
    if (info.remaining >= 10 && info.lastResort && this.packages.some((p) => p.lastResort)) return;
    const body: { packages: string[]; lastResort?: string } = { packages: [] };
    if (info.remaining < 10) for (let i = 0; i < 20; i++) body.packages.push(await make(false));
    if (!info.lastResort || !this.packages.some((p) => p.lastResort)) { this.packages = this.packages.filter((p) => !p.lastResort); body.lastResort = await make(true); }
    await c.http('PUT', '/v1/keypackages', body);
    await c.flush(); // the private halves must be on disk before anyone can use the public ones
  }

  // ---------- creating a group ----------
  async create(gid: string, meta: M.GroupMeta) {
    const kp = await M.newKeyPackage(this.c.device.mlsSig, this.c.account.accountId, this.c.device.deviceId);
    this.adopt(gid, await M.createGroupState(gid, { pub: kp.pub, priv: kp.priv }, meta, this.cfg));
    const g = this.host.group(gid); if (g) this.host.applyMeta(g, meta);
  }

  // ---------- reconciling the roster with the tree ----------
  scheduleReconcile(gid: string, ms = 50 + Math.random() * 300) {
    this.host.later(() => this.reconcile(gid), ms);
  }

  async reconcile(gid: string) {
    const g = this.host.group(gid), st = this.states.get(gid), c = this.c;
    if (!g || g.removed || !st || g.kind !== 'group') return;
    const myAcct = c.account.accountId, myDev = c.device.deviceId;
    const members = M.membersOf(st);
    if (!members.some((m) => m.account === myAcct && m.device === myDev)) { this.forget(gid); return; } // I was removed
    const roster = g.members.map((m) => m.accountId);
    const want = new Map<string, Map<string, PrekeyBundleWire>>();
    for (const a of roster) {
      try { want.set(a, new Map((await this.bundles(a, true)).map((b) => [b.deviceId, b]))); } catch { this.scheduleReconcile(gid, 5000); return; }
    }
    const lost = this.resync.get(gid) ?? new Set<string>();
    const removes = members.filter((m) => !(m.account === myAcct && m.device === myDev) && (!want.get(m.account)?.has(m.device) || lost.has(`${m.account}:${m.device}`))).map((m) => m.leaf);
    const have = new Set(members.filter((m) => !lost.has(`${m.account}:${m.device}`)).map((m) => `${m.account}:${m.device}`));
    const adds: Uint8Array[] = [], targets: { toAccount: string; toDevice: string }[] = [];
    for (const [account, devs] of want) {
      const missing = [...devs.keys()].filter((d) => !have.has(`${account}:${d}`));
      if (!missing.length) continue;
      const { packages } = await c.http<{ packages: KeyPackageClaim[] }>('POST', '/v1/keypackages/claim', { accountId: account });
      for (const d of missing) {
        const p = packages.find((x) => x.deviceId === d);
        if (!p) continue; // that device has not left an invitation yet; a later reconcile picks it up
        const bytes = unb64(p.keyPackage);
        try {
          const kp = M.decodeKeyPackage(bytes), id = M.identityOf(kp.leafNode.credential);
          if (!id || id.account !== account || id.device !== d || !equal(kp.leafNode.signaturePublicKey, unb64(devs.get(d)!.mlsKey))) throw new Error('key package does not match the certified device');
          adds.push(bytes); targets.push({ toAccount: account, toDevice: d });
        } catch (e) { c.onError(e); }
      }
    }
    if (!adds.length && !removes.length) return;
    const r = await M.commit(st, { add: adds, remove: removes });
    try {
      await c.http('POST', `/v1/groups/${gid}/commit`, {
        epoch: M.epochOf(st), commit: b64(r.commit), welcomes: r.welcome ? targets.map((t) => ({ ...t, welcome: b64(r.welcome!) })) : [],
      });
    } catch (e) {
      if ((e as any)?.status === 409) { this.scheduleReconcile(gid); return; } // someone else committed first; their commit is on its way
      throw e;
    }
    this.adopt(gid, r.state); M.release(r.consumed);
    this.resync.delete(gid);
    this.afterChange(gid);
  }

  noteResync(gid: string, account: string, device: string) {
    if (account === this.c.account.accountId && device === this.c.device.deviceId) return; // that is me asking
    const set = this.resync.get(gid) ?? new Set<string>(); set.add(`${account}:${device}`); this.resync.set(gid, set);
  }

  /** This device could not follow the group any more (a commit failed to apply). Drop its state and ask to be replaced. */
  async recover(gid: string) {
    this.forget(gid); this.asked.delete(gid);
    this.c.onError(new Error('group keys lost on this device: asking the group to add it again'));
    await this.c.http('POST', `/v1/groups/${gid}/hello`, { resync: true }).catch(() => {});
    this.host.touch();
  }

  /** A device that is in a group's roster but has no keys for it asks the others to add it. */
  async askToJoin(gid: string) {
    const last = this.asked.get(gid) ?? 0;
    if (Date.now() - last < 60_000 || this.states.has(gid)) return;
    this.asked.set(gid, Date.now());
    await this.c.http('POST', `/v1/groups/${gid}/hello`).catch(() => {});
  }

  private afterChange(gid: string) {
    const g = this.host.group(gid), st = this.states.get(gid);
    if (g && st) { const m = M.metaOf(st); if (m) this.host.applyMeta(g, m); }
    this.host.touch();
  }

  // ---------- inbound ----------
  async onWelcome(w: WireMessage) {
    const gid = w.group!;
    if (this.states.has(gid)) return;
    await this.host.refresh(gid, true);
    const bytes = unb64(w.body);
    for (const p of [...this.packages].sort((x, y) => Number(x.lastResort) - Number(y.lastResort))) {
      try {
        const kp = M.decodeKeyPackage(p.pub);
        const s = await M.joinFromWelcome(bytes, { pub: kp, priv: M.decodePrivate(p.priv) }, this.cfg);
        if (M.groupIdOf(s) !== gid) continue;
        this.adopt(gid, s);
        if (!p.lastResort) this.packages = this.packages.filter((x) => x !== p);
        this.afterChange(gid);
        void this.maintainKeyPackages().catch((e) => this.c.onError(e));
        this.scheduleReconcile(gid); // there may be more to do now (another new device, someone removed)
        return;
      } catch { /* wrong key package for this welcome: try the next one */ }
    }
    this.c.onError(new Error('could not open a group welcome'));
  }

  private policy(gid: string, st: ClientState, devices: Map<string, Set<string>>): M.Policy {
    const g = this.host.group(gid)!;
    return {
      isAdmin: (a) => this.host.isAdmin(g, a), roster: () => new Set(g.members.map((m) => m.accountId)),
      memberAt: (leaf) => { const m = M.membersOf(st).find((x) => x.leaf === leaf); return m ? { account: m.account, device: m.device } : null; },
      deviceActive: (a, d) => !!devices.get(a)?.has(d),
    };
  }
  private async activeDevices(g: GroupState) {
    const out = new Map<string, Set<string>>();
    for (const m of g.members) { try { out.set(m.accountId, new Set((await this.bundles(m.accountId, true)).map((b) => b.deviceId))); } catch { /* unknown: treated as not active */ } }
    return out;
  }

  async onCommit(w: WireMessage) {
    const gid = w.group!, st = this.states.get(gid);
    if (!st) return; // not a member (yet): nothing to apply
    await this.host.refresh(gid, true);
    const g = this.host.group(gid); if (!g) return;
    try {
      const r = await M.receive(st, unb64(w.body), M.commitPolicy(this.policy(gid, st, await this.activeDevices(g))));
      if (r.kind !== 'commit') return;
      this.adopt(gid, r.state);
      if (!M.membersOf(r.state).some((m) => m.account === this.c.account.accountId && m.device === this.c.device.deviceId)) { this.forget(gid); this.host.touch(); return; }
      this.afterChange(gid);
      this.scheduleReconcile(gid);
    } catch (e) {
      this.c.onError(e);
      if (!/policy/.test(String((e as Error)?.message))) await this.recover(gid); // a refused commit is the policy working; anything else means we fell out of step
    }
  }

  /** Returns false when the keys for this message have not arrived yet (it is kept and retried). */
  async onMessage(g: GroupState, w: WireMessage): Promise<boolean> {
    const st = this.states.get(g.id);
    if (!st) return false;
    try {
      const r = await M.receive(st, unb64(w.body), M.commitPolicy(this.policy(g.id, st, new Map())));
      if (r.kind !== 'message') return true;
      this.adopt(g.id, r.state);
      const who = M.openApp(r.state, g.id, r.plaintext);
      if (!g.members.some((m) => m.accountId === who.account)) return true; // not in the server's roster: drop
      this.host.deliverEnvelope(g, who.account, JSON.parse(fromUtf8(who.envelope)) as Envelope, w);
    } catch (e) { this.c.onError(e); } // forged, replayed or corrupt: drop it
    return true;
  }

  // ---------- outbound ----------
  async encryptEnvelope(gid: string, env: Envelope): Promise<Uint8Array> {
    const st = this.states.get(gid);
    if (!st) throw new Error('this group is not ready on this device yet');
    const sealed = M.sealApp(this.c.device.mlsSig, gid, this.c.account.accountId, this.c.device.deviceId, utf8(JSON.stringify(env)), M.epochOf(st));
    const r = await M.encrypt(st, sealed);
    this.adopt(gid, r.state);
    return r.bytes;
  }

  /** Rename or re-pin through a commit (only admins; everyone else rejects it). One attempt: a 409 means another commit won the epoch. */
  async commitMeta(gid: string, meta: M.GroupMeta) {
    const st = this.states.get(gid); if (!st) throw new Error('this group is not ready on this device yet');
    const r = await M.commit(st, { meta });
    await this.c.http('POST', `/v1/groups/${gid}/commit`, { epoch: M.epochOf(st), commit: b64(r.commit), welcomes: [] });
    this.adopt(gid, r.state); M.release(r.consumed); this.afterChange(gid);
  }
}
