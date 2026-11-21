// The sandboxed interface never holds identity keys or ratchets. Every crypto call goes to libsignal in native code over a
// narrow bridge: the desktop app's main process (apps/desktop/preload.cjs) or the phone app's native plugin (apps/mobile).
// This class makes that bridge look like a SignalProvider.
import type { SignalProvider, RemoteBundle, Ciphertext, PrekeyWire, SignedPrekeyWire } from '@vanishgram/client-core';

interface Bridge { open(): Promise<number>; call(handle: number, method: string, args: unknown[]): Promise<any>; close(handle: number): Promise<void> }
interface Cap { isNativePlatform?(): boolean; Plugins?: Record<string, any>; registerPlugin?<T>(name: string): T }
declare global { interface Window { vgSignal?: Bridge; Capacitor?: Cap } }

// Phone app: bytes cross the Capacitor bridge as {"$u8": base64}, and each result comes back wrapped as JSON {"v": ...}.
const toB64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
const enc = (_k: string, v: unknown) => (v instanceof Uint8Array ? { $u8: toB64(v) } : v);
const dec = (_k: string, v: any) => (v && typeof v === 'object' && typeof v.$u8 === 'string' ? fromB64(v.$u8) : v);

function capacitorBridge(): Bridge | null {
  const cap = window.Capacitor;
  if (!cap?.isNativePlatform?.() || !cap.registerPlugin) return null;
  const p = cap.registerPlugin<{ open(): Promise<{ handle: number }>; call(o: { handle: number; method: string; args: string }): Promise<{ result: string }>; close(o: { handle: number }): Promise<void> }>('VgSignal');
  return {
    open: async () => (await p.open()).handle,
    call: async (handle, method, args) => JSON.parse((await p.call({ handle, method, args: JSON.stringify(args, enc) })).result, dec).v,
    close: (handle) => p.close({ handle }),
  };
}
if (typeof window !== 'undefined' && !window.vgSignal) { const b = capacitorBridge(); if (b) window.vgSignal = b; }

export const bridgeAvailable = () => typeof window !== 'undefined' && !!window.vgSignal;

export class IpcSignal implements SignalProvider {
  private handle: Promise<number> | null = null;
  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    const b = window.vgSignal;
    if (!b) return Promise.reject(new Error('the crypto engine is only available in the desktop and phone apps'));
    this.handle ??= b.open();
    return this.handle.then((h) => b.call(h, method, args));
  }
  create() { return this.call<void>('create'); }
  load(state: Uint8Array) { return this.call<void>('load', state); }
  save() { return this.call<Uint8Array>('save').then((u) => new Uint8Array(u)); }
  identityKey() { return this.call<string>('identityKey'); }
  registrationId() { return this.call<number>('registrationId'); }
  signedPrekey() { return this.call<SignedPrekeyWire>('signedPrekey'); }
  kyberPrekey() { return this.call<SignedPrekeyWire>('kyberPrekey'); }
  newOneTimePrekeys(count: number) { return this.call<PrekeyWire[]>('newOneTimePrekeys', count); }
  oneTimePrekeyCount() { return this.call<number>('oneTimePrekeyCount'); }
  rotatePrekeys() { return this.call<void>('rotatePrekeys'); }
  verify(identityKey: string, message: Uint8Array, signature: string) { return this.call<boolean>('verify', identityKey, message, signature); }
  trust(peer: string, identityKey: string) { return this.call<void>('trust', peer, identityKey); }
  hasSession(peer: string) { return this.call<boolean>('hasSession', peer); }
  processBundle(peer: string, remoteDeviceId: number, bundle: RemoteBundle) { return this.call<void>('processBundle', peer, remoteDeviceId, bundle); }
  encrypt(peer: string, plaintext: Uint8Array) { return this.call<Ciphertext>('encrypt', peer, plaintext).then((c) => ({ type: c.type, body: new Uint8Array(c.body) })); }
  decrypt(peer: string, ct: Ciphertext) { return this.call<Uint8Array>('decrypt', peer, ct).then((u) => new Uint8Array(u)); }
  dropSession(peer: string) { return this.call<void>('dropSession', peer); }
}
