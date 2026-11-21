import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { DOMAIN, type DeviceKeysWire, type PrekeyBundleWire } from '@vanishgram/protocol';
import { b64, unb64, concat, utf8, hex, u32 } from './encoding.ts';
import { accountIdFromPublicKey, type AccountKeys } from './account.ts';
import { newSignalProvider, type SignalProvider } from './signal.ts';

/** A device is an id plus a crypto engine that holds its identity, prekeys and sessions (libsignal). */
export interface DeviceKeys { deviceId: string; signal: SignalProvider; /** signs this device's MLS group credentials */ mlsSig: { priv: Uint8Array; pub: Uint8Array } }

const certMsg = (deviceId: string, identityKey: Uint8Array, registrationId: number, mlsKey: Uint8Array) =>
  concat(utf8(DOMAIN.deviceCert), utf8(deviceId), identityKey, u32(registrationId), mlsKey);

export async function createDevice(): Promise<DeviceKeys> {
  const signal = newSignalProvider();
  await signal.create();
  return { deviceId: hex(randomBytes(8)), signal, mlsSig: newMlsSig() };
}

export function newMlsSig() { const priv = randomBytes(32); return { priv, pub: ed25519.getPublicKey(priv) }; }

/** Make `count` new one-time prekeys and return their public halves for upload. */
export const topUpPrekeys = (d: DeviceKeys, count: number) => d.signal.newOneTimePrekeys(count);

/** The account key certifies the device identity: stops the server from injecting its own device. */
export async function deviceToWire(acct: AccountKeys, d: DeviceKeys, opks: { id: number; pub: string }[], label = ''): Promise<DeviceKeysWire> {
  const [identityKey, registrationId, signedPrekey, kyberPrekey] = await Promise.all([d.signal.identityKey(), d.signal.registrationId(), d.signal.signedPrekey(), d.signal.kyberPrekey()]);
  return {
    deviceId: d.deviceId, ...(label ? { label } : {}), identityKey, registrationId, mlsKey: b64(d.mlsSig.pub),
    cert: b64(ed25519.sign(certMsg(d.deviceId, unb64(identityKey), registrationId, d.mlsSig.pub), acct.authSeed)),
    signedPrekey, kyberPrekey, oneTimePrekeys: opks,
  };
}

/** Throws unless the bundle chains to the account key whose hash IS the account id, and its prekeys are signed by the device identity. */
export async function verifyBundle(b: PrekeyBundleWire, expectedAccountId: string, signal: SignalProvider): Promise<void> {
  const authPub = unb64(b.authPublicKey);
  if (b.accountId !== expectedAccountId || accountIdFromPublicKey(authPub) !== expectedAccountId)
    throw new Error('account id does not match authentication key');
  if (!ed25519.verify(unb64(b.cert), certMsg(b.deviceId, unb64(b.identityKey), b.registrationId, unb64(b.mlsKey)), authPub)) throw new Error('bad device certificate');
  if (!(await signal.verify(b.identityKey, unb64(b.signedPrekey.pub), b.signedPrekey.sig))) throw new Error('bad signed prekey');
  if (!(await signal.verify(b.identityKey, unb64(b.kyberPrekey.pub), b.kyberPrekey.sig))) throw new Error('bad kyber prekey');
}

/** Human-comparable fingerprint of two account keys (order independent). */
export function safetyNumber(a: Uint8Array, b: Uint8Array): string {
  const [x, y] = hex(a) < hex(b) ? [a, b] : [b, a];
  const h = hex(sha256(concat(x, y)));
  return h.slice(0, 30).match(/.{5}/g)!.join(' ');
}
