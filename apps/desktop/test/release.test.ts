import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
const { canonical, verifyRelease } = createRequire(import.meta.url)('../release-verify.cjs');

const k = generateKeyPairSync('ed25519');
const pub = k.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const make = (v: string, files: { name: string; sha512: string }[]) => { const r: any = { version: v, files }; r.sig = sign(null, Buffer.from(canonical(r)), k.privateKey).toString('base64'); return r; };

test('only a release signed with the built-in key is accepted, and any change to it breaks the signature', () => {
  const r = make('1.2.3', [{ name: 'Vanishgram-1.2.3-win-x64.exe', sha512: 'AAAA' }, { name: 'Vanishgram-1.2.3-linux-x86_64.AppImage', sha512: 'BBBB' }]);
  assert.equal(verifyRelease(r, pub), true);
  assert.equal(verifyRelease({ ...r, version: '1.2.4' }, pub), false, 'version swapped');
  assert.equal(verifyRelease({ ...r, files: [{ ...r.files[0], sha512: 'EVIL' }, r.files[1]] }, pub), false, 'a file hash swapped');
  assert.equal(verifyRelease({ ...r, files: [r.files[0]] }, pub), false, 'a file dropped');
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  assert.equal(verifyRelease(r, other), false, 'signed by a different key');
  assert.equal(verifyRelease({ version: '1.2.3', files: r.files }, pub), false, 'no signature');
  assert.equal(verifyRelease({ ...r, version: '1.2' }, pub), false, 'malformed version');
  assert.equal(verifyRelease(null, pub), false);
});
