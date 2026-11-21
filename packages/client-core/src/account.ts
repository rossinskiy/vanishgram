import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { DOMAIN } from '@vanishgram/protocol';
import { hex, utf8, concat } from './encoding.ts';

export interface AccountKeys {
  accountId: string;
  authSeed: Uint8Array; // Ed25519 private seed, never leaves the client
  authPublicKey: Uint8Array;
  syncKey: Uint8Array; // for encrypted account-state sync (future)
}

/** 12 words = 128 bits of entropy (BIP-39). */
export const newMnemonic = (): string => generateMnemonic(wordlist, 128);

export function isValidMnemonic(m: string): boolean {
  const norm = normalizeMnemonic(m);
  return norm.split(' ').length === 12 && validateMnemonic(norm, wordlist);
}
export const normalizeMnemonic = (m: string): string => m.trim().toLowerCase().split(/\s+/).join(' ');

export const accountIdFromPublicKey = (pub: Uint8Array): string => hex(sha256(pub)).slice(0, 32);

/** Deterministic, domain-separated derivation. Phrase never leaves this function's caller. */
export function deriveAccount(mnemonic: string): AccountKeys {
  const m = normalizeMnemonic(mnemonic);
  if (!isValidMnemonic(m)) throw new Error('invalid recovery phrase');
  const seed = mnemonicToSeedSync(m); // PBKDF2-HMAC-SHA512, 2048 rounds (BIP-39)
  const root = hkdf(sha256, seed, undefined, utf8(DOMAIN.accountRoot), 32);
  const authSeed = hkdf(sha256, root, undefined, utf8(DOMAIN.accountAuth), 32);
  const syncKey = hkdf(sha256, root, undefined, utf8(DOMAIN.accountSync), 32);
  const authPublicKey = ed25519.getPublicKey(authSeed);
  return { accountId: accountIdFromPublicKey(authPublicKey), authSeed, authPublicKey, syncKey };
}

/** Message the client signs to log in. Binds account, server nonce and purpose. */
export const loginMessage = (accountId: string, nonce: string): Uint8Array =>
  concat(utf8(DOMAIN.login), utf8('|'), utf8(accountId), utf8('|'), utf8(nonce));

export const signLogin = (a: AccountKeys, nonce: string): Uint8Array =>
  ed25519.sign(loginMessage(a.accountId, nonce), a.authSeed);
