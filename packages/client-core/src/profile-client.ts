// Profile, privacy settings, blocking, presence, typing and read receipts.
import type { VanishClient } from './client.ts';

export interface Privacy {
  lastSeen: 'everyone' | 'contacts' | 'nobody';
  profile: 'everyone' | 'contacts';
  invites: 'everyone' | 'contacts' | 'nobody';
  unknownMessages: 'allow' | 'contacts';
  typing: boolean;
  readReceipts: boolean;
}
export const DEFAULT_PRIVACY: Privacy = { lastSeen: 'everyone', profile: 'everyone', invites: 'everyone', unknownMessages: 'allow', typing: true, readReceipts: true };
export interface DeviceInfo { deviceId: string; label: string; createdAt: number; lastSeen: number; current: boolean }
export type ReportKind = 'spam' | 'abuse' | 'impersonation' | 'illegal' | 'other';
export interface MyProfile { displayName: string; bio: string; avatarVersion: number; privacy: Privacy }

export class ProfileManager {
  c: VanishClient;
  me: MyProfile = { displayName: '', bio: '', avatarVersion: 0, privacy: { ...DEFAULT_PRIVACY } };
  private lastTyping = new Map<string, number>();
  private avatars = new Map<string, Uint8Array | null>(); // key `${id}:${version}`
  constructor(c: VanishClient) { this.c = c; }

  async load(): Promise<MyProfile> {
    this.me = await this.c.http<MyProfile>('GET', '/v1/profile');
    this.c.onChange();
    return this.me;
  }
  async update(p: { displayName: string; bio: string }) {
    await this.c.http('PUT', '/v1/profile', p);
    this.me = { ...this.me, ...p }; this.c.onChange();
  }
  async setAvatar(bytes: Uint8Array) {
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const r = await this.c.http<{ avatarVersion: number }>('PUT', '/v1/profile/avatar', { data: btoa(s) });
    this.me.avatarVersion = r.avatarVersion; this.c.onChange();
  }
  async removeAvatar() { await this.c.http('DELETE', '/v1/profile/avatar'); this.me.avatarVersion += 1; this.c.onChange(); }

  /** Avatar bytes for an account, cached per version. Null when none or not visible. */
  async avatar(id: string, version: number): Promise<Uint8Array | null> {
    if (!version) return null;
    const key = `${id}:${version}`;
    if (this.avatars.has(key)) return this.avatars.get(key)!;
    try {
      const res = await fetch(`${this.c.baseUrl}/v1/accounts/${id}/avatar?v=${version}`, { headers: { authorization: `Bearer ${this.c.token}` } });
      const bytes = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      if (this.avatars.size > 200) this.avatars.clear();
      this.avatars.set(key, bytes);
      return bytes;
    } catch { return null; }
  }

  async setPrivacy(patch: Partial<Privacy>) { this.me.privacy = await this.c.http<Privacy>('PUT', '/v1/privacy', patch); this.c.onChange(); }

  // ---- blocks ----
  async blocked(): Promise<string[]> { return (await this.c.http<{ blocked: string[] }>('GET', '/v1/blocks')).blocked; }
  async block(id: string) { await this.c.http('POST', '/v1/blocks', { accountId: id }); this.c.blockedSet.add(id); this.c.onChange(); this.c.flushSoon(); }
  async unblock(id: string) { await this.c.http('DELETE', `/v1/blocks/${id}`); this.c.blockedSet.delete(id); this.c.onChange(); this.c.flushSoon(); }

  // ---- devices ----
  devices() { return this.c.http<{ devices: DeviceInfo[] }>('GET', '/v1/devices').then((r) => r.devices); }
  revokeDevice(id: string) { return this.c.http('DELETE', `/v1/devices/${id}`); }
  revokeOtherDevices() { return this.c.http<{ revoked: number }>('POST', '/v1/devices/revoke-others'); }

  // ---- abuse reports: the reporter decides what, if anything, is attached ----
  report(accountId: string, kind: ReportKind, note = '', evidence?: { from: string; ts: number; body: string }[]) {
    return this.c.http('POST', '/v1/reports', { accountId, kind, note, ...(evidence?.length ? { evidence, consent: true } : {}) });
  }
  status() { return this.c.http<{ restriction: 'none' | 'limited' | 'suspended' | 'banned'; until: number | null }>('GET', '/v1/account/status'); }

  async presence(id: string): Promise<string | null> { return (await this.c.http<{ status: string | null }>('GET', `/v1/accounts/${id}/presence`)).status; }

  // ---- typing (ephemeral, never stored) ----
  typing(peer: string) {
    if (!this.me.privacy.typing) return;
    const now = Date.now();
    if (now - (this.lastTyping.get(peer) ?? 0) < 3000) return;
    this.lastTyping.set(peer, now);
    this.c.sendFrame({ type: 'typing', to: peer });
  }

  // ---- read receipts: an encrypted envelope, sent only if I allow it ----
  async markRead(peer: string) {
    if (!this.me.privacy.readReceipts) return;
    const ids = (this.c.chats.get(peer) ?? []).filter((m) => m.from === peer && !m.sys && !this.c.receipted.has(m.id)).map((m) => m.id);
    if (!ids.length) return;
    for (const id of ids) this.c.receipted.add(id);
    if (this.c.receipted.size > 5000) this.c.receipted = new Set([...this.c.receipted].slice(-2500));
    await this.c.deliver(peer, { t: 'read', ids: ids.slice(-100), ts: Date.now() }).catch((e) => this.c.onError(e));
    this.c.flushSoon();
  }
}
