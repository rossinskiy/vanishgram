// The sandboxed interface never holds identity keys or ratchets. Every crypto call goes to libsignal in the desktop
// app's main process over a narrow bridge (see apps/desktop/preload.cjs). This class makes that bridge look like a SignalProvider.
import type { SignalProvider, RemoteBundle, Ciphertext, PrekeyWire, SignedPrekeyWire } from '@vanishgram/client-core';

interface Bridge { open(): Promise<number>; call(handle: number, method: string, args: unknown[]): Promise<any>; close(handle: number): Promise<void> }
declare global { interface Window { vgSignal?: Bridge } }

export const bridgeAvailable = () => typeof window !== 'undefined' && !!window.vgSignal;

export class IpcSignal implements SignalProvider {
  private handle: Promise<number> | null = null;
  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    const b = window.vgSignal;
    if (!b) return Promise.reject(new Error('the crypto engine is only available in the desktop app'));
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
