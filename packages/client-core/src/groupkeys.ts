// Group message encryption with per-sender "sender key" chains (the design Signal uses for groups).
// Each member device owns one chain: a symmetric ratchet (forward secrecy within the chain) plus an
// Ed25519 key that signs every ciphertext so group members cannot forge each other's messages.
// Chains are handed to other members ONLY through pairwise E2EE sessions. When someone is removed,
// every remaining member starts a fresh chain and does not give it to the removed account.
// Weaker than MLS: no post-compromise healing inside a chain until the next rotation. See docs.
import { ed25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { b64, unb64, concat, utf8, u32, readU32, hex } from './encoding.ts';
import { pad, unpad } from './encoding.ts';

const LABEL = 'vanishgram/v1/group-msg';
const MAX_SKIP = 1000;
const HEADER = 8 + 4 + 64; // chainId | n | signature

export interface OwnChain { chainId: string; ck: Uint8Array; n: number; signPriv: Uint8Array; signPub: Uint8Array }
export interface RecvChain { chainId: string; ck: Uint8Array; n: number; signPub: Uint8Array; skipped: Map<number, Uint8Array> }
export interface Distribution { chainId: string; ck: string; n: number; signPub: string }

export function newChain(): OwnChain {
  const signPriv = randomBytes(32);
  return { chainId: hex(randomBytes(8)), ck: randomBytes(32), n: 0, signPriv, signPub: ed25519.getPublicKey(signPriv) };
}

export const distributionOf = (c: OwnChain): Distribution => ({ chainId: c.chainId, ck: b64(c.ck), n: c.n, signPub: b64(c.signPub) });

export function receiverFrom(d: Distribution): RecvChain {
  const ck = unb64(d.ck), signPub = unb64(d.signPub);
  if (ck.length !== 32 || signPub.length !== 32 || !/^[0-9a-f]{16}$/.test(d.chainId) || !Number.isInteger(d.n) || d.n < 0) throw new Error('bad sender key');
  return { chainId: d.chainId, ck, n: d.n, signPub, skipped: new Map() };
}

const step = (ck: Uint8Array): [Uint8Array, Uint8Array] => [hmac(sha256, ck, Uint8Array.of(2)), hmac(sha256, ck, Uint8Array.of(1))];
const aead = (mk: Uint8Array, aad: Uint8Array) => {
  const o = hkdf(sha256, mk, undefined, utf8('vanishgram/v1/group-msg-key'), 44);
  return chacha20poly1305(o.slice(0, 32), o.slice(32, 44), aad);
};
const aadOf = (gid: string, acct: string, dev: string, chainId: string, n: number) =>
  concat(utf8(LABEL), utf8('|'), utf8(gid), utf8('|'), utf8(acct), utf8('|'), utf8(dev), utf8('|'), utf8(chainId), u32(n));

export const chainIdOf = (wire: Uint8Array): string => hex(wire.slice(0, 8));

export function encrypt(c: OwnChain, gid: string, acct: string, dev: string, plaintext: Uint8Array): Uint8Array {
  const [next, mk] = step(c.ck);
  const n = c.n;
  c.ck = next; c.n++;
  const aad = aadOf(gid, acct, dev, c.chainId, n);
  const ct = aead(mk, aad).encrypt(pad(plaintext));
  const sig = ed25519.sign(concat(aad, ct), c.signPriv);
  return concat(hexBytes(c.chainId), u32(n), sig, ct);
}
const hexBytes = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

/** Verifies the signature, then decrypts on a copy of the chain; the new chain state is returned only on success. */
export function decrypt(rc: RecvChain, gid: string, acct: string, dev: string, wire: Uint8Array): { chain: RecvChain; plaintext: Uint8Array } {
  if (wire.length < HEADER + 16) throw new Error('truncated group message');
  const chainId = chainIdOf(wire);
  if (chainId !== rc.chainId) throw new Error('wrong chain');
  const n = readU32(wire, 8), sig = wire.slice(12, 76), ct = wire.slice(76);
  const aad = aadOf(gid, acct, dev, chainId, n);
  if (!ed25519.verify(sig, concat(aad, ct), rc.signPub)) throw new Error('bad group message signature');
  const s = structuredClone(rc);
  let mk = s.skipped.get(n);
  if (mk) s.skipped.delete(n);
  else {
    if (n < s.n) throw new Error('replayed group message');
    if (n - s.n > MAX_SKIP) throw new Error('too many skipped group messages');
    while (s.n < n) { const [ck, k] = step(s.ck); s.skipped.set(s.n, k); s.ck = ck; s.n++; }
    const [ck, k] = step(s.ck); s.ck = ck; s.n++; mk = k;
  }
  return { chain: s, plaintext: unpad(aead(mk, aad).decrypt(ct)) };
}
