// One-to-one voice calls. This file is the signaling state machine; the browser supplies the actual
// WebRTC peer through the CallPeer adapter (so the logic is testable without a browser).
//
// Security model: SDP offers/answers (which carry the DTLS certificate fingerprints) and ICE candidates
// travel ONLY inside pairwise E2EE sessions. The server relays opaque ciphertext and cannot swap a
// fingerprint, so DTLS-SRTP audio is end-to-end encrypted between the two devices, even through a TURN
// relay. A short code derived from both fingerprints lets users confirm it by voice.
import type { Envelope, IceConfig } from '@vanishgram/protocol';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex, utf8, readU32 } from './encoding.ts';
import type { VanishClient } from './client.ts';

export interface IceCand { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
export type PeerState = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

/** What the platform (browser) must provide. */
export interface CallPeer {
  start(ice: IceConfig['iceServers'], relayOnly: boolean): Promise<void>; // acquire microphone, create the connection
  createOffer(): Promise<string>;
  createAnswer(offerSdp: string): Promise<string>;
  setAnswer(sdp: string): Promise<void>;
  addIce(c: IceCand): Promise<void>;
  setMuted(muted: boolean): void;
  close(): void;
  onIce: (c: IceCand) => void;
  onState: (s: PeerState) => void;
}
export type PeerFactory = () => CallPeer;

export type CallStatus = 'calling' | 'incoming' | 'connecting' | 'connected' | 'ended';
export interface CallState {
  id: string; peer: string; incoming: boolean; status: CallStatus; muted: boolean;
  startedAt: number | null; sas: string | null; reason: string | null; relayOnly: boolean;
}
interface Active extends CallState {
  p: CallPeer | null; remoteDevice: string | null; offerSdp: string | null; answerSdp: string | null;
  pendingIce: IceCand[]; incomingIce: IceCand[]; remoteReady: boolean;
  ringTimer: ReturnType<typeof setTimeout> | null; iceTimer: ReturnType<typeof setTimeout> | null; lostTimer: ReturnType<typeof setTimeout> | null;
}
type Sig = Extract<Envelope, { t: 'call-offer' | 'call-answer' | 'call-ice' | 'call-end' | 'call-reject' }>;

const fingerprintOf = (sdp: string) => /a=fingerprint:[\w-]+ ([0-9A-Fa-f:]+)/.exec(sdp)?.[1]?.toUpperCase() ?? '';
/** Same on both sides: hash of the two DTLS fingerprints, shown as two 4-digit groups. */
export function callCode(offerSdp: string, answerSdp: string): string {
  const h = sha256(utf8([fingerprintOf(offerSdp), fingerprintOf(answerSdp)].sort().join('|')));
  const g = (o: number) => String(readU32(h, o) % 10000).padStart(4, '0');
  return `${g(0)} ${g(4)}`;
}

export class CallManager {
  c: VanishClient;
  factory: PeerFactory | null = null;
  ringTimeoutMs = 45_000;
  private cur: Active | null = null;
  private ended = new Set<string>();

  constructor(c: VanishClient) { this.c = c; }

  get supported() { return !!this.factory; }
  get state(): CallState | null { return this.cur ? this.view(this.cur) : null; }
  private view(a: Active): CallState {
    return { id: a.id, peer: a.peer, incoming: a.incoming, status: a.status, muted: a.muted, startedAt: a.startedAt, sas: a.sas, reason: a.reason, relayOnly: a.relayOnly };
  }
  private emit(a: Active | CallState | null) { this.c.onCall(a ? ('p' in a ? this.view(a as Active) : (a as CallState)) : null); }
  private send(peer: string, env: Envelope, device?: string) { return this.c.deliver(peer, env, device).catch((e) => this.c.onError(e)); }

  private wire(a: Active, p: CallPeer) {
    a.p = p;
    p.onIce = (cand) => { a.pendingIce.push(cand); this.scheduleIce(a); };
    p.onState = (s) => {
      if (this.cur !== a) return;
      if (s === 'connected') {
        if (a.lostTimer) { clearTimeout(a.lostTimer); a.lostTimer = null; }
        if (a.ringTimer) { clearTimeout(a.ringTimer); a.ringTimer = null; }
        a.status = 'connected'; a.startedAt ??= Date.now(); this.emit(a);
      } else if (s === 'disconnected') {
        a.status = 'connecting'; this.emit(a); // brief network change: give it a few seconds to recover
        a.lostTimer ??= setTimeout(() => this.end(a, 'connection-lost', true), 10_000);
      } else if (s === 'failed') this.end(a, 'connection-failed', true);
    };
  }

  private scheduleIce(a: Active) {
    if (a.iceTimer || !a.remoteDevice) return;
    a.iceTimer = setTimeout(() => {
      a.iceTimer = null;
      if (!a.pendingIce.length || !a.remoteDevice || this.cur !== a) return;
      const candidates = a.pendingIce.splice(0);
      void this.send(a.peer, { t: 'call-ice', callId: a.id, candidates }, a.remoteDevice);
    }, 120); // batch trickle candidates to stay well under message rate limits
  }

  private blank(id: string, peer: string, incoming: boolean): Active {
    return { id, peer, incoming, status: incoming ? 'incoming' : 'calling', muted: false, startedAt: null, sas: null, reason: null, relayOnly: false,
      p: null, remoteDevice: null, offerSdp: null, answerSdp: null, pendingIce: [], incomingIce: [], remoteReady: false, ringTimer: null, iceTimer: null, lostTimer: null };
  }

  // ---------- caller ----------
  async start(peer: string, opts: { relayOnly?: boolean } = {}): Promise<void> {
    if (!this.factory) throw new Error('voice calls are not supported in this environment');
    if (this.cur) throw new Error('already in a call');
    const a = this.blank(hex(crypto.getRandomValues(new Uint8Array(12))), peer, false);
    this.cur = a; this.emit(a);
    try {
      const ice = await this.c.http<IceConfig>('GET', '/v1/calls/ice');
      a.relayOnly = !!opts.relayOnly && ice.relayAvailable;
      this.wire(a, this.factory());
      await a.p!.start(ice.iceServers, a.relayOnly);
      a.offerSdp = await a.p!.createOffer();
      await this.c.deliver(peer, { t: 'call-offer', callId: a.id, sdp: a.offerSdp, ts: Date.now() });
    } catch (e) { this.end(a, 'error', false); throw e; }
    a.ringTimer = setTimeout(() => this.end(a, 'no-answer', true), this.ringTimeoutMs);
    this.emit(a);
  }

  // ---------- callee ----------
  async accept(): Promise<void> {
    const a = this.cur;
    if (!a || !a.incoming || a.status !== 'incoming' || !this.factory) throw new Error('no incoming call');
    if (a.ringTimer) { clearTimeout(a.ringTimer); a.ringTimer = null; }
    a.status = 'connecting'; this.emit(a);
    try {
      const ice = await this.c.http<IceConfig>('GET', '/v1/calls/ice');
      this.wire(a, this.factory());
      await a.p!.start(ice.iceServers, false);
      a.answerSdp = await a.p!.createAnswer(a.offerSdp!);
      a.remoteReady = true;
      a.sas = callCode(a.offerSdp!, a.answerSdp);
      await this.c.deliver(a.peer, { t: 'call-answer', callId: a.id, sdp: a.answerSdp }, a.remoteDevice!);
      // stop my other devices from ringing
      void this.send(this.c.account.accountId, { t: 'call-end', callId: a.id, reason: 'handled-elsewhere', keep: this.c.device.deviceId });
      for (const cand of a.incomingIce.splice(0)) await a.p!.addIce(cand).catch((e) => this.c.onError(e));
      this.scheduleIce(a); this.emit(a);
    } catch (e) { this.end(a, 'error', true); throw e; }
  }

  decline(): void {
    const a = this.cur;
    if (!a || !a.incoming || a.status !== 'incoming') return;
    void this.send(a.peer, { t: 'call-end', callId: a.id, reason: 'declined' }, a.remoteDevice ?? undefined);
    void this.send(this.c.account.accountId, { t: 'call-end', callId: a.id, reason: 'handled-elsewhere', keep: this.c.device.deviceId });
    this.finish(a, 'declined');
  }

  // ---------- both ----------
  hangup(): void {
    const a = this.cur;
    if (!a) return;
    if (a.incoming && a.status === 'incoming') return this.decline();
    this.end(a, a.status === 'calling' ? 'cancelled' : 'hangup', true);
  }

  setMuted(muted: boolean) { const a = this.cur; if (!a) return; a.muted = muted; a.p?.setMuted(muted); this.emit(a); }

  /** Close the call and tell the other side (unless it told us). */
  private end(a: Active, reason: string, notify: boolean) {
    if (this.cur !== a) return;
    if (notify) void this.send(a.peer, { t: 'call-end', callId: a.id, reason }, a.remoteDevice ?? undefined);
    this.finish(a, reason);
  }

  private finish(a: Active, reason: string) {
    if (this.cur !== a) return;
    this.cur = null;
    for (const t of [a.ringTimer, a.iceTimer, a.lostTimer]) if (t) clearTimeout(t);
    try { a.p?.close(); } catch { /* already closed */ }
    this.ended.add(a.id);
    if (this.ended.size > 100) this.ended = new Set([...this.ended].slice(-50));
    a.status = 'ended'; a.reason = reason;
    this.log(a, reason);
    this.emit(a); this.emit(null);
  }

  /** A local, non-synced note in the chat: what happened to this call. */
  private log(a: Active, reason: string) {
    if (reason === 'handled-elsewhere' || reason === 'answered-elsewhere' || reason === 'error') return;
    const dur = a.startedAt ? Math.max(1, Math.round((Date.now() - a.startedAt) / 1000)) : 0;
    const mm = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}`;
    const text = a.startedAt ? `Voice call, ${mm}`
      : a.incoming ? (reason === 'declined' ? 'Declined voice call' : 'Missed voice call')
        : reason === 'declined' ? 'Voice call declined' : reason === 'busy' ? 'Voice call: line busy' : reason === 'cancelled' ? 'Cancelled voice call' : 'Voice call: no answer';
    const m = this.c.store(a.peer, { id: `call-${a.id}`, from: a.incoming ? a.peer : this.c.account.accountId, body: text, ts: Date.now(), serverIds: [], sys: true });
    if (a.incoming && !a.startedAt && reason !== 'declined') this.c.onMessage(a.peer, m);
  }

  // ---------- signaling in ----------
  async onSignal(from: string, fromDevice: string, env: Sig): Promise<void> {
    const me = this.c.account.accountId, a = this.cur;
    switch (env.t) {
      case 'call-offer': {
        if (from === me || this.ended.has(env.callId) || (a && a.id === env.callId)) return;
        if (!this.c.chats.has(from)) { // strangers cannot ring you: they must message first
          this.ended.add(env.callId);
          void this.send(from, { t: 'call-reject', callId: env.callId, reason: 'unknown' }, fromDevice);
          return;
        }
        if (Date.now() - env.ts > this.ringTimeoutMs) { // arrived after it stopped ringing
          this.ended.add(env.callId);
          const m = this.c.store(from, { id: `call-${env.callId}`, from, body: 'Missed voice call', ts: env.ts, serverIds: [], sys: true });
          this.c.onMessage(from, m);
          return;
        }
        if (a) { this.ended.add(env.callId); void this.send(from, { t: 'call-reject', callId: env.callId, reason: 'busy' }, fromDevice); return; }
        const n = this.blank(env.callId, from, true);
        n.remoteDevice = fromDevice; n.offerSdp = env.sdp;
        n.ringTimer = setTimeout(() => this.finish(n, 'missed'), this.ringTimeoutMs);
        this.cur = n; this.emit(n);
        return;
      }
      case 'call-answer': {
        if (!a || a.incoming || a.id !== env.callId || from !== a.peer || a.remoteDevice) return;
        a.remoteDevice = fromDevice; a.answerSdp = env.sdp;
        if (a.ringTimer) { clearTimeout(a.ringTimer); a.ringTimer = null; }
        a.status = 'connecting';
        try {
          await a.p!.setAnswer(env.sdp);
          a.remoteReady = true;
          a.sas = callCode(a.offerSdp!, env.sdp);
          for (const cand of a.incomingIce.splice(0)) await a.p!.addIce(cand).catch((e) => this.c.onError(e));
        } catch (e) { this.c.onError(e); this.end(a, 'error', true); return; }
        // other devices of the callee stop ringing
        void this.send(a.peer, { t: 'call-end', callId: a.id, reason: 'answered-elsewhere', keep: fromDevice });
        this.scheduleIce(a); this.emit(a);
        return;
      }
      case 'call-ice': {
        if (!a || a.id !== env.callId || from !== a.peer || (a.remoteDevice && fromDevice !== a.remoteDevice)) return;
        for (const cand of env.candidates.slice(0, 50)) {
          if (a.remoteReady && a.p) await a.p.addIce(cand).catch((e) => this.c.onError(e));
          else if (a.incomingIce.length < 100) a.incomingIce.push(cand);
        }
        return;
      }
      case 'call-end': {
        if (!a || a.id !== env.callId) return;
        if (env.keep && env.keep === this.c.device.deviceId) return; // told to ignore: this device is the one in the call
        if (from === me) { if (a.incoming && a.status === 'incoming') this.finish(a, 'handled-elsewhere'); return; }
        if (from !== a.peer) return;
        if (a.remoteDevice && fromDevice !== a.remoteDevice) return;
        this.finish(a, env.reason === 'declined' && a.incoming ? 'hangup' : env.reason);
        return;
      }
      case 'call-reject': {
        if (!a || a.incoming || a.id !== env.callId || from !== a.peer || a.remoteDevice) return;
        this.finish(a, env.reason);
        return;
      }
    }
  }
}
