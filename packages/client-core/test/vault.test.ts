import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealVault, openVault, WrongPassphraseError, type KdfParams } from '../src/vault.ts';
import { encodeState, decodeState } from '../src/serialize.ts';
import { utf8, fromUtf8 } from '../src/encoding.ts';

const FAST: KdfParams = { t: 2, m: 19 * 1024, p: 1 };

test('serializer round-trips bytes, maps and sets', () => {
  const v = { a: new Uint8Array([1, 2, 3]), m: new Map([['k', { z: new Uint8Array([9]) }]]), s: new Set(['x']), n: 5 };
  const r = decodeState<typeof v>(encodeState(v));
  assert.deepEqual(r, v);
});

test('vault: round trip, wrong passphrase, tamper, header downgrade, short passphrase', async () => {
  const file = await sealVault('correct horse', 'acct1', utf8('secret state'), FAST);
  assert.ok(!Buffer.from(file).toString('latin1').includes('secret state'));
  const ok = await openVault('correct horse', file);
  assert.equal(fromUtf8(ok.plaintext), 'secret state');
  assert.equal(ok.label, 'acct1');
  await assert.rejects(openVault('wrong horse!!', file), WrongPassphraseError);
  const bad = file.slice(); bad[bad.length - 1]! ^= 1;
  await assert.rejects(openVault('correct horse', bad), WrongPassphraseError);
  // flipping the account label in the header must fail (header is AAD)
  const relabeled = Buffer.from(file).toString('latin1').replace('acct1', 'acct2');
  await assert.rejects(openVault('correct horse', new Uint8Array(Buffer.from(relabeled, 'latin1'))), WrongPassphraseError);
  // weak KDF parameters are refused even with the right passphrase
  const weak = await sealVault('correct horse', 'a', utf8('x'), { t: 1, m: 8, p: 1 });
  await assert.rejects(openVault('correct horse', weak), /out of accepted range/);
  await assert.rejects(sealVault('short', 'a', utf8('x'), FAST), /too short/);
  assert.notDeepEqual(await sealVault('correct horse', 'a', utf8('x'), FAST), await sealVault('correct horse', 'a', utf8('x'), FAST)); // fresh salt+nonce
});
