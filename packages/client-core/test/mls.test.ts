import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { utf8, fromUtf8, hex } from '../src/encoding.ts';
import * as M from '../src/mls.ts';

const acct = () => hex(randomBytes(16)), dev = () => hex(randomBytes(8));
interface P { account: string; device: string; sig: M.SigKeys; cfg: ReturnType<typeof M.clientConfig> }
const person = (certified: Map<string, Uint8Array>, account = acct()): P => {
  const priv = randomBytes(32), device = dev(), sig = { priv, pub: ed25519.getPublicKey(priv) };
  certified.set(`${account}:${device}`, sig.pub); // what the account certificate would vouch for
  return { account, device, sig, cfg: M.clientConfig(async (a, d, k) => { const want = certified.get(`${a}:${d}`); return !!want && Buffer.from(want).equals(Buffer.from(k)); }) };
};
const policyFor = (state: () => Parameters<typeof M.membersOf>[0], roster: Set<string>, admins: Set<string>): M.Policy => ({
  isAdmin: (a) => admins.has(a), roster: () => roster, memberAt: (leaf) => { const m = M.membersOf(state()).find((x) => x.leaf === leaf); return m ? { account: m.account, device: m.device } : null; },
  deviceActive: () => true,
});

test('MLS groups: create, add with welcome, messages, rename, remove, post-quantum suite', async () => {
  const cert = new Map<string, Uint8Array>();
  const a = person(cert), b = person(cert), c = person(cert);
  const roster = new Set([a.account, b.account]); const admins = new Set([a.account]);
  const kpA = await M.newKeyPackage(a.sig, a.account, a.device), kpB = await M.newKeyPackage(b.sig, b.account, b.device);
  let sa = await M.createGroupState('group-1', kpA, { name: 'First', description: '', pinned: null, ts: 1 }, a.cfg);
  assert.equal(M.metaOf(sa)!.name, 'First');

  // add b: a commits, b joins from the welcome and sees the name without anyone telling it
  const add = await M.commit(sa, { add: [kpB.publicBytes] });
  sa = add.state; M.release(add.consumed);
  let sb = await M.joinFromWelcome(add.welcome!, kpB, b.cfg);
  assert.equal(M.metaOf(sb)!.name, 'First');
  assert.deepEqual(M.membersOf(sb).map((m) => m.account).sort(), [a.account, b.account].sort());

  // messages both ways
  let m1 = await M.encrypt(sa, utf8('hello group')); sa = m1.state;
  const r1 = await M.receive(sb, m1.bytes, M.commitPolicy(policyFor(() => sb, roster, admins))); sb = r1.state;
  assert.equal(r1.kind === 'message' && fromUtf8(r1.plaintext), 'hello group');
  const m2 = await M.encrypt(sb, utf8('hi a')); sb = m2.state;
  const r2 = await M.receive(sa, m2.bytes, M.commitPolicy(policyFor(() => sa, roster, admins))); sa = r2.state;
  assert.equal(r2.kind === 'message' && fromUtf8(r2.plaintext), 'hi a');

  // a late message: sent at the old epoch, arrives after a commit
  const late = await M.encrypt(sa, utf8('sent before the commit')); sa = late.state;
  roster.add(c.account);
  const kpC = await M.newKeyPackage(c.sig, c.account, c.device);
  const addC = await M.commit(sa, { add: [kpC.publicBytes] }); sa = addC.state;
  const pol = () => M.commitPolicy(policyFor(() => sb, roster, admins));
  let got = await M.receive(sb, addC.commit, pol()); sb = got.state;
  assert.equal(got.kind, 'commit');
  got = await M.receive(sb, late.bytes, pol()); sb = got.state;
  assert.equal(got.kind === 'message' && fromUtf8(got.plaintext), 'sent before the commit', 'key retention opens a message from the previous epoch');
  let sc = await M.joinFromWelcome(addC.welcome!, kpC, c.cfg);

  // rename: only an admin may
  const ren = await M.commit(sa, { meta: { name: 'Renamed', description: 'd', pinned: null, ts: 2 } }); sa = ren.state;
  got = await M.receive(sb, ren.commit, pol()); sb = got.state; assert.equal(M.metaOf(sb)!.name, 'Renamed');
  const sneaky = await M.commit(sb, { meta: { name: 'Hijacked', description: '', pinned: null, ts: 3 } });
  await assert.rejects(M.receive(sa, sneaky.commit, M.commitPolicy(policyFor(() => sa, roster, admins))), 'a non-admin cannot rename the group');

  // remove c once the server removed it; the removed device cannot read what follows
  roster.delete(c.account);
  const leafC = M.membersOf(sa).find((m) => m.account === c.account)!.leaf;
  const rem = await M.commit(sa, { remove: [leafC] }); sa = rem.state;
  got = await M.receive(sb, rem.commit, pol()); sb = got.state;
  assert.deepEqual(M.membersOf(sb).map((m) => m.account).sort(), [a.account, b.account].sort());
  const after = await M.encrypt(sa, utf8('c must not read this')); sa = after.state;
  await assert.rejects(M.receive(sc, after.bytes, M.commitPolicy(policyFor(() => sc, roster, admins))), 'the removed member cannot decrypt the new epoch');
  void sc;

  // a member cannot remove someone the server still lists, nor add someone the server never admitted
  const sneakyRemove = await M.commit(sb, { remove: [M.membersOf(sb).find((m) => m.account === a.account)!.leaf] });
  await assert.rejects(M.receive(sa, sneakyRemove.commit, M.commitPolicy(policyFor(() => sa, roster, admins))), 'removing a member the server still lists is rejected');
  const d = person(cert); const kpD = await M.newKeyPackage(d.sig, d.account, d.device);
  const sneakyAdd = await M.commit(sb, { add: [kpD.publicBytes] });
  await assert.rejects(M.receive(sa, sneakyAdd.commit, M.commitPolicy(policyFor(() => sa, roster, admins))), 'adding an account the server did not admit is rejected');
});

test('credentials must be certified: a key package signed by an uncertified key cannot be added', async () => {
  const cert = new Map<string, Uint8Array>();
  const a = person(cert), b = person(cert);
  cert.delete(`${b.account}:${b.device}`); // the account never certified this signature key
  const kpA = await M.newKeyPackage(a.sig, a.account, a.device), kpB = await M.newKeyPackage(b.sig, b.account, b.device);
  const sa = await M.createGroupState('group-2', kpA, { name: 'x', description: '', pinned: null, ts: 1 }, a.cfg);
  await assert.rejects(M.commit(sa, { add: [kpB.publicBytes] }), 'the library asks our check and the check says no');
});

test('state survives save and load', async () => {
  const cert = new Map<string, Uint8Array>();
  const a = person(cert), b = person(cert);
  const kpA = await M.newKeyPackage(a.sig, a.account, a.device), kpB = await M.newKeyPackage(b.sig, b.account, b.device);
  let sa = await M.createGroupState('group-3', kpA, { name: 'persist', description: '', pinned: null, ts: 1 }, a.cfg);
  const add = await M.commit(sa, { add: [kpB.publicBytes] }); sa = add.state;
  const sb = await M.joinFromWelcome(add.welcome!, kpB, b.cfg);
  const sa2 = M.loadState(M.saveState(sa), a.cfg), sb2 = M.loadState(M.saveState(sb), b.cfg);
  assert.equal(M.metaOf(sa2)!.name, 'persist');
  const m = await M.encrypt(sa2, utf8('after reload'));
  const r = await M.receive(sb2, m.bytes, () => 'accept');
  assert.equal(r.kind === 'message' && fromUtf8(r.plaintext), 'after reload');
  assert.equal(M.groupIdOf(sb2), 'group-3');
});

test('sender attribution: the signature, not the server, says who wrote a message', async () => {
  const cert = new Map<string, Uint8Array>();
  const a = person(cert), b = person(cert);
  const kpA = await M.newKeyPackage(a.sig, a.account, a.device), kpB = await M.newKeyPackage(b.sig, b.account, b.device);
  let sa = await M.createGroupState('group-4', kpA, { name: 'x', description: '', pinned: null, ts: 1 }, a.cfg);
  const add = await M.commit(sa, { add: [kpB.publicBytes] }); sa = add.state;
  const sb = await M.joinFromWelcome(add.welcome!, kpB, b.cfg);
  const env = utf8('{"t":"text"}');
  const ok = M.sealApp(a.sig, 'group-4', a.account, a.device, env, M.epochOf(sa));
  assert.deepEqual(M.openApp(sb, 'group-4', ok), { account: a.account, device: a.device, envelope: env });
  const forged = M.sealApp(b.sig, 'group-4', a.account, a.device, env, M.epochOf(sa)); // b signs but claims to be a
  assert.throws(() => M.openApp(sb, 'group-4', forged), /signature/);
  assert.throws(() => M.openApp(sb, 'other-group', ok), /signature/, 'bound to the group');
});
