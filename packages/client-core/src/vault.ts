// Encrypted-at-rest container for client state.
// File = MAGIC | header JSON length (u32) | header JSON | ChaCha20-Poly1305 ciphertext.
// Key = Argon2id(passphrase, random salt). The header is bound as AAD, so tampering with
// KDF parameters or the account label makes decryption fail.
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { b64, unb64, concat, utf8, fromUtf8, u32, readU32 } from './encoding.ts';

const MAGIC = utf8('VGVAULT1');

export interface KdfParams { t: number; m: number; p: number } // m in KiB
/** ~64 MiB, 3 passes: interactive-login class cost on desktop/mobile. */
export const DEFAULT_KDF: KdfParams = { t: 3, m: 64 * 1024, p: 1 };
/** Floor enforced when opening: a swapped-in weak header must not be accepted silently. */
export const MIN_KDF: KdfParams = { t: 2, m: 19 * 1024, p: 1 };

export interface VaultBackend {
  read(): Promise<Uint8Array | null>;
  /** Must be atomic: a crash leaves either the old or the new vault, never a torn one. */
  write(bytes: Uint8Array): Promise<void>;
  remove(): Promise<void>;
}

export class WrongPassphraseError extends Error { constructor() { super('wrong passphrase or corrupted vault'); } }

interface Header { v: 1; kdf: 'argon2id'; salt: string; nonce: string; label: string; params: KdfParams }

const deriveKey = (pass: string, salt: Uint8Array, p: KdfParams) =>
  argon2idAsync(utf8(pass.normalize('NFKC')), salt, { t: p.t, m: p.m, p: p.p, dkLen: 32 });

/** Derived once per unlock (Argon2id is slow on purpose); each write uses a fresh random nonce. */
export interface VaultKey { salt: Uint8Array; params: KdfParams; key: Uint8Array }

export async function createVaultKey(pass: string, params: KdfParams = DEFAULT_KDF): Promise<VaultKey> {
  if (pass.length < 8) throw new Error('passphrase too short (min 8)');
  const salt = randomBytes(16);
  return { salt, params, key: await deriveKey(pass, salt, params) };
}

export function sealWithKey(vk: VaultKey, label: string, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(12);
  const header: Header = { v: 1, kdf: 'argon2id', salt: b64(vk.salt), nonce: b64(nonce), label, params: vk.params };
  const h = utf8(JSON.stringify(header));
  return concat(MAGIC, u32(h.length), h, chacha20poly1305(vk.key, nonce, concat(MAGIC, h)).encrypt(plaintext));
}

export async function sealVault(pass: string, label: string, plaintext: Uint8Array, params: KdfParams = DEFAULT_KDF): Promise<Uint8Array> {
  return sealWithKey(await createVaultKey(pass, params), label, plaintext);
}

export async function openVault(pass: string, file: Uint8Array, opts: { minKdf?: KdfParams } = {}): Promise<{ label: string; plaintext: Uint8Array; vaultKey: VaultKey }> {
  const min = opts.minKdf ?? MIN_KDF;
  if (file.length < MAGIC.length + 4 + 16 || fromUtf8(file.slice(0, MAGIC.length)) !== fromUtf8(MAGIC)) throw new Error('not a Vanishgram vault');
  const hl = readU32(file, MAGIC.length);
  const hStart = MAGIC.length + 4;
  if (hl > 1024 || hStart + hl > file.length) throw new Error('corrupted vault header');
  const h = file.slice(hStart, hStart + hl);
  const header = JSON.parse(fromUtf8(h)) as Header;
  if (header.v !== 1 || header.kdf !== 'argon2id') throw new Error('unsupported vault version');
  const p = header.params;
  if (p.t < min.t || p.m < min.m || p.p < min.p || p.m > 1024 * 1024) throw new Error('vault KDF parameters out of accepted range');
  const key = await deriveKey(pass, unb64(header.salt), p);
  try {
    const plaintext = chacha20poly1305(key, unb64(header.nonce), concat(MAGIC, h)).decrypt(file.slice(hStart + hl));
    return { label: header.label, plaintext, vaultKey: { salt: unb64(header.salt), params: p, key } };
  } catch { throw new WrongPassphraseError(); }
}
