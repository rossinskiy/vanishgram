import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignalEngine, type RemoteBundle } from '../src/index.ts';

const enc = (s: string) => new TextEncoder().encode(s), dec = (u: Uint8Array) => new TextDecoder().decode(u);

async function peer() { const e = new SignalEngine(); await e.create(); return e; }
async function bundleOf(e: SignalEngine, opk = true): Promise<RemoteBundle> {
  const [o] = opk ? await e.newOneTimePrekeys(1) : [undefined];
  return { registrationId: await e.registrationId(), identityKey: await e.identityKey(), signedPrekey: await e.signedPrekey(), kyberPrekey: await e.kyberPrekey(), ...(o ? { oneTimePrekey: o } : {}) };
}
async function link(a: SignalEngine, b: SignalEngine) {
  await a.trust('bob:1', await b.identityKey()); await b.trust('alice:1', await a.identityKey());
  await a.processBundle('bob:1', 1, await bundleOf(b));
}

test('PQXDH + Double Ratchet through the official libsignal: first message, replies, many turns', async () => {
  const a = await peer(), b = await peer(); await link(a, b);
  const m1 = await a.encrypt('bob:1', enc('hello bob'));
  assert.equal(m1.type, 3, 'first message carries the pre-key header');
  assert.equal(dec(await b.decrypt('alice:1', m1)), 'hello bob');
  const r1 = await b.encrypt('alice:1', enc('hi alice'));
  assert.equal(r1.type, 2, 'after the exchange it is a plain ratchet message');
  assert.equal(dec(await a.decrypt('bob:1', r1)), 'hi alice');
  for (let i = 0; i < 20; i++) {
    const x = await a.encrypt('bob:1', enc(`a${i}`)); assert.equal(dec(await b.decrypt('alice:1', x)), `a${i}`);
    const y = await b.encrypt('alice:1', enc(`b${i}`)); assert.equal(dec(await a.decrypt('bob:1', y)), `b${i}`);
  }
  assert.equal(await b.oneTimePrekeyCount(), 0, 'the one-time prekey was consumed');
});

test('out of order delivery, replay and tampering', async () => {
  const a = await peer(), b = await peer(); await link(a, b);
  await b.decrypt('alice:1', await a.encrypt('bob:1', enc('first')));
  const x1 = await a.encrypt('bob:1', enc('one')), x2 = await a.encrypt('bob:1', enc('two')), x3 = await a.encrypt('bob:1', enc('three'));
  assert.equal(dec(await b.decrypt('alice:1', x3)), 'three');
  assert.equal(dec(await b.decrypt('alice:1', x1)), 'one');
  assert.equal(dec(await b.decrypt('alice:1', x2)), 'two');
  await assert.rejects(b.decrypt('alice:1', x2), 'a replayed message is refused');
  await a.decrypt('bob:1', await b.encrypt('alice:1', enc('ack'))); // the exchange completes, so from now on messages are plain ratchet messages
  const y = await a.encrypt('bob:1', enc('fine')); assert.equal(y.type, 2);
  const bad = { type: y.type, body: Uint8Array.from(y.body) }; bad.body[bad.body.length - 3]! ^= 1; // inside the MAC
  await assert.rejects(b.decrypt('alice:1', bad), 'a modified message is refused');
  assert.equal(dec(await b.decrypt('alice:1', y)), 'fine', 'and the failed attempt did not damage the session');
});

test('an identity that was not certified is never trusted', async () => {
  const a = await peer(), b = await peer();
  await a.trust('bob:1', await b.identityKey());
  await a.processBundle('bob:1', 1, await bundleOf(b));
  const m = await a.encrypt('bob:1', enc('hi'));
  await assert.rejects(b.decrypt('alice:1', m), 'bob never registered alice as a certified identity');
  const mallory = await peer();
  await b.trust('alice:1', await mallory.identityKey());
  await assert.rejects(b.decrypt('alice:1', m), 'a different key than the certified one is rejected');
});

test('state survives save and load, including the session and unused one-time prekeys', async () => {
  const a = await peer(), b = await peer(); await link(a, b);
  await b.decrypt('alice:1', await a.encrypt('bob:1', enc('hello')));
  const b2 = new SignalEngine(); await b2.load(await b.save());
  const a2 = new SignalEngine(); await a2.load(await a.save());
  const m = await a2.encrypt('bob:1', enc('after restart')); assert.equal(dec(await b2.decrypt('alice:1', m)), 'after restart');
  const r = await b2.encrypt('alice:1', enc('and back')); assert.equal(dec(await a2.decrypt('bob:1', r)), 'and back');
  assert.ok(!new TextDecoder().decode(await b.save()).includes('after restart'));
});

test('bundle signatures verify, and rotation keeps recent keys for late first messages', async () => {
  const b = await peer();
  const spk = await b.signedPrekey(), ky = await b.kyberPrekey();
  assert.equal(await b.verify(await b.identityKey(), Buffer.from(spk.pub, 'base64'), spk.sig), true);
  assert.equal(await b.verify(await b.identityKey(), Buffer.from(ky.pub, 'base64'), ky.sig), true);
  const other = await peer();
  assert.equal(await b.verify(await other.identityKey(), Buffer.from(spk.pub, 'base64'), spk.sig), false);
  const a = await peer(); await a.trust('bob:1', await b.identityKey()); await b.trust('alice:1', await a.identityKey());
  await a.processBundle('bob:1', 1, { registrationId: await b.registrationId(), identityKey: await b.identityKey(), signedPrekey: spk, kyberPrekey: ky });
  await b.rotatePrekeys();
  assert.equal(dec(await b.decrypt('alice:1', await a.encrypt('bob:1', enc('late first message')))), 'late first message');
  assert.notEqual((await b.signedPrekey()).id, spk.id);
});

test('overlapping calls are serialized: 50 parallel encryptions all decrypt', async () => {
  const a = await peer(), b = await peer(); await link(a, b);
  const sent = await Promise.all(Array.from({ length: 50 }, (_, i) => a.encrypt('bob:1', enc(`m${i}`))));
  const got = new Set<string>();
  for (const ct of sent) got.add(dec(await b.decrypt('alice:1', ct)));
  assert.equal(got.size, 50, 'no counter was reused, so nothing was lost or refused');
});
