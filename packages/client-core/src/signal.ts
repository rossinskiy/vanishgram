// The crypto engine contract. The real implementation is libsignal (packages/signal-engine), which runs in a Node process:
// the Electron main process, or tests. The sandboxed interface reaches it through a small bridge that implements this same interface.
export interface PrekeyWire { id: number; pub: string }
export interface SignedPrekeyWire extends PrekeyWire { sig: string }
export interface RemoteBundle {
  registrationId: number; identityKey: string; signedPrekey: SignedPrekeyWire; kyberPrekey: SignedPrekeyWire; oneTimePrekey?: PrekeyWire;
}
export interface Ciphertext { type: number; body: Uint8Array }

export interface SignalProvider {
  /** New identity and first prekeys. */
  create(): Promise<void>;
  /** Restore from the bytes returned by save(). */
  load(state: Uint8Array): Promise<void>;
  /** Everything needed to resume: identity, prekeys, sessions. The caller encrypts it before it touches a disk. */
  save(): Promise<Uint8Array>;
  identityKey(): Promise<string>;
  registrationId(): Promise<number>;
  signedPrekey(): Promise<SignedPrekeyWire>;
  kyberPrekey(): Promise<SignedPrekeyWire>;
  /** Make `count` more one-time prekeys; returns only the new public halves. */
  newOneTimePrekeys(count: number): Promise<PrekeyWire[]>;
  oneTimePrekeyCount(): Promise<number>;
  /** Replace the signed and Kyber prekeys (recent old ones are kept so late first messages still open). */
  rotatePrekeys(): Promise<void>;
  /** Does `signature` verify for `message` under `identityKey`? Used to check bundles. */
  verify(identityKey: string, message: Uint8Array, signature: string): Promise<boolean>;
  /** Record that `identityKey` is the key certified for `peer`. Nothing from an unregistered key is ever trusted. */
  trust(peer: string, identityKey: string): Promise<void>;
  hasSession(peer: string): Promise<boolean>;
  processBundle(peer: string, remoteDeviceId: number, bundle: RemoteBundle): Promise<void>;
  encrypt(peer: string, plaintext: Uint8Array): Promise<Ciphertext>;
  decrypt(peer: string, ct: Ciphertext): Promise<Uint8Array>;
  /** Forget a peer device (it signed out). */
  dropSession(peer: string): Promise<void>;
}

/** Hosts install a factory once at start-up: the desktop app uses a bridge to libsignal, tests use the engine directly. */
let factory: (() => SignalProvider) | null = null;
export const setSignalFactory = (f: () => SignalProvider) => { factory = f; };
export function newSignalProvider(): SignalProvider {
  if (!factory) throw new Error('no crypto engine installed (call setSignalFactory first)');
  return factory();
}
