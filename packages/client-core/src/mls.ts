// Group encryption with MLS (RFC 9420) through ts-mls: a ratchet tree of member DEVICES, a new epoch (fresh keys) on every
// membership change, post-compromise healing, and the X-Wing hybrid KEM (X25519 plus ML-KEM-768) so groups get post-quantum
// key agreement like the pairwise chats do. ts-mls is a pure TypeScript library and has not been independently audited.
//
// This file is the thin layer between the library and our rules; groups-client.ts decides WHEN to call it.
import {
  createGroup, joinGroup, createCommit, createApplicationMessage, processPrivateMessage, processPublicMessage, generateKeyPackageWithKey,
  encodeMlsMessage, decodeMlsMessage, encodeGroupState, decodeGroupState, getCiphersuiteImpl, getCiphersuiteFromName, defaultCapabilities, defaultLifetime,
  emptyPskIndex, defaultKeyRetentionConfig, defaultLifetimeConfig, defaultKeyPackageEqualityConfig, defaultPaddingConfig, zeroOutUint8Array,
  type ClientState, type CiphersuiteImpl, type ClientConfig, type Credential, type Proposal, type KeyPackage, type PrivateKeyPackage,
  type Extension, type IncomingMessageCallback, type LeafNode,
} from 'ts-mls';
import { ed25519 } from '@noble/curves/ed25519.js';
import { utf8, fromUtf8, b64, unb64, concat, u32 } from './encoding.ts';

export const MLS_SUITE = 'MLS_256_XWING_AES256GCM_SHA512_Ed25519';
/** Application extension in the GroupContext that carries the group's name, description and pinned message. */
export const META_EXTENSION = 0xff01;

let implP: Promise<CiphersuiteImpl> | null = null;
export const mlsImpl = () => (implP ??= getCiphersuiteImpl(getCiphersuiteFromName(MLS_SUITE)));

export interface SigKeys { priv: Uint8Array; pub: Uint8Array }
export interface GroupMeta { name: string; description: string; pinned: string | null; ts: number }
export interface Member { leaf: number; account: string; device: string; sigKey: Uint8Array }

export const credentialOf = (account: string, device: string): Credential => ({ credentialType: 'basic', identity: utf8(`${account}:${device}`) });
export function identityOf(c: Credential): { account: string; device: string } | null {
  if (c.credentialType !== 'basic') return null;
  const m = /^([0-9a-f]{32}):([0-9a-f]{16})$/.exec(fromUtf8(c.identity));
  return m ? { account: m[1]!, device: m[2]! } : null;
}

/** Called for every credential the library meets. Only a key certified by the account may sign for that account's device. */
export type CredentialCheck = (account: string, device: string, sigPub: Uint8Array) => Promise<boolean>;

export function clientConfig(check: CredentialCheck): ClientConfig {
  return {
    lifetimeConfig: defaultLifetimeConfig, keyPackageEqualityConfig: defaultKeyPackageEqualityConfig, paddingConfig: defaultPaddingConfig,
    // keep keys for a few past epochs: a message sent just before a commit can arrive just after it
    keyRetentionConfig: { ...defaultKeyRetentionConfig, retainKeysForEpochs: 4, retainKeysForGenerations: 100, maximumForwardRatchetSteps: 1000 },
    authService: { async validateCredential(cred, sigPub) { const id = identityOf(cred); return !!id && check(id.account, id.device, sigPub); } },
  };
}

const metaExt = (m: GroupMeta): Extension => ({ extensionType: META_EXTENSION, extensionData: utf8(JSON.stringify(m)) });
export function metaOf(s: ClientState): GroupMeta | null {
  const e = s.groupContext.extensions.find((x) => Number(x.extensionType) === META_EXTENSION);
  if (!e) return null;
  try { const m = JSON.parse(fromUtf8(e.extensionData as Uint8Array)); return { name: String(m.name ?? ''), description: String(m.description ?? ''), pinned: m.pinned ?? null, ts: Number(m.ts) || 0 }; } catch { return null; }
}

export const capabilities = () => { const c = defaultCapabilities(); return { ...c, extensions: [...c.extensions, META_EXTENSION] } as typeof c; };

/** One KeyPackage for this device, signed with the device's certified MLS signature key. */
export async function newKeyPackage(sig: SigKeys, account: string, device: string): Promise<{ publicBytes: Uint8Array; priv: PrivateKeyPackage; pub: KeyPackage }> {
  const impl = await mlsImpl();
  const lifetime = { notBefore: BigInt(Math.floor(Date.now() / 1000) - 3600), notAfter: BigInt(Math.floor(Date.now() / 1000) + 60 * 86400) };
  const kp = await generateKeyPackageWithKey(credentialOf(account, device), capabilities(), lifetime, [], { signKey: sig.priv, publicKey: sig.pub }, impl);
  return { publicBytes: encodeMlsMessage({ keyPackage: kp.publicPackage, wireformat: 'mls_key_package', version: 'mls10' }), priv: kp.privatePackage, pub: kp.publicPackage };
}
export const encodePrivate = (p: PrivateKeyPackage) => ({ i: b64(p.initPrivateKey), h: b64(p.hpkePrivateKey), s: b64(p.signaturePrivateKey) });
export const decodePrivate = (o: { i: string; h: string; s: string }): PrivateKeyPackage => ({ initPrivateKey: unb64(o.i), hpkePrivateKey: unb64(o.h), signaturePrivateKey: unb64(o.s) });
export function decodeKeyPackage(bytes: Uint8Array): KeyPackage {
  const d = decodeMlsMessage(bytes, 0);
  if (!d || d[0].wireformat !== 'mls_key_package') throw new Error('not a key package');
  return d[0].keyPackage;
}

/** Create a group with this device as the only member. */
export async function createGroupState(groupId: string, kp: { pub: KeyPackage; priv: PrivateKeyPackage }, meta: GroupMeta, cfg: ClientConfig): Promise<ClientState> {
  return createGroup(utf8(groupId), kp.pub, kp.priv, [metaExt(meta)], await mlsImpl(), cfg);
}

export async function joinFromWelcome(welcome: Uint8Array, kp: { pub: KeyPackage; priv: PrivateKeyPackage }, cfg: ClientConfig): Promise<ClientState> {
  const d = decodeMlsMessage(welcome, 0);
  if (!d || d[0].wireformat !== 'mls_welcome') throw new Error('not a welcome');
  return joinGroup(d[0].welcome, kp.pub, kp.priv, emptyPskIndex, await mlsImpl(), undefined, undefined, cfg);
}

export function membersOf(s: ClientState): Member[] {
  const out: Member[] = []; let leaf = 0;
  for (let i = 0; i < s.ratchetTree.length; i += 2) {
    const n = s.ratchetTree[i];
    if (n && n.nodeType === 'leaf') {
      const id = identityOf((n.leaf as LeafNode).credential);
      if (id) out.push({ leaf, account: id.account, device: id.device, sigKey: (n.leaf as LeafNode).signaturePublicKey });
    }
    leaf++;
  }
  return out;
}
export const epochOf = (s: ClientState) => Number(s.groupContext.epoch);
export const groupIdOf = (s: ClientState) => fromUtf8(s.groupContext.groupId);

export interface CommitPlan { add?: Uint8Array[]; remove?: number[]; meta?: GroupMeta }
/** Build a commit. Returns the new state (do not adopt it until the server has accepted the commit), the commit, and a welcome for new members. */
export async function commit(state: ClientState, plan: CommitPlan): Promise<{ state: ClientState; commit: Uint8Array; welcome: Uint8Array | null; consumed: Uint8Array[] }> {
  const impl = await mlsImpl();
  const proposals: Proposal[] = [];
  for (const r of plan.remove ?? []) proposals.push({ proposalType: 'remove', remove: { removed: r } });
  for (const k of plan.add ?? []) proposals.push({ proposalType: 'add', add: { keyPackage: decodeKeyPackage(k) } });
  if (plan.meta) proposals.push({ proposalType: 'group_context_extensions', groupContextExtensions: { extensions: [metaExt(plan.meta)] } });
  const r = await createCommit({ state, cipherSuite: impl }, { extraProposals: proposals, ratchetTreeExtension: true });
  // `consumed` is old key material that belongs to the OLD state: wipe it only once the new state is adopted (release()), because
  // the server may refuse this commit (another member won the epoch) and the old state must stay usable.
  return {
    consumed: r.consumed, state: r.newState,
    commit: encodeMlsMessage(r.commit),
    welcome: r.welcome ? encodeMlsMessage({ welcome: r.welcome, wireformat: 'mls_welcome', version: 'mls10' }) : null,
  };
}

/** What we allow other members to do, decided from the server-enforced roster. A malicious member cannot make anyone accept more. */
export interface Policy {
  isAdmin(account: string): boolean;
  /** Accounts that belong in the group right now according to the server. */
  roster(): Set<string>;
  /** Who sits at this leaf of the CURRENT (pre-commit) tree. */
  memberAt(leaf: number): { account: string; device: string } | null;
  /** Is this a device the account currently has registered (not a signed-out one)? */
  deviceActive(account: string, device: string): boolean;
}
export function commitPolicy(p: Policy): IncomingMessageCallback {
  return (incoming) => {
    if (incoming.kind !== 'commit') return 'reject'; // standalone proposals are not used: every change is a commit
    const sender = incoming.senderLeafIndex === undefined ? null : p.memberAt(Number(incoming.senderLeafIndex));
    if (!sender) return 'reject';
    // a device that lost its keys is replaced: its old leaf may go if the same commit adds the same device again
    const readded = new Set<string>();
    for (const { proposal } of incoming.proposals) if ((proposal as { proposalType: string }).proposalType === 'add') { const id = identityOf((proposal as any).add.keyPackage.leafNode.credential); if (id) readded.add(`${id.account}:${id.device}`); }
    for (const { proposal } of incoming.proposals) {
      const t = (proposal as { proposalType: string }).proposalType;
      if (t === 'add') {
        const id = identityOf((proposal as any).add.keyPackage.leafNode.credential);
        if (!id || !p.roster().has(id.account)) return 'reject'; // only accounts the server has admitted
      } else if (t === 'remove') {
        const target = p.memberAt(Number((proposal as any).remove.removed));
        // only devices that are gone: signed out, or belonging to an account the server removed (or the committer's own devices)
        if (target && target.account !== sender.account && p.roster().has(target.account) && p.deviceActive(target.account, target.device) && !readded.has(`${target.account}:${target.device}`)) return 'reject';
      } else if (t === 'group_context_extensions') {
        if (!p.isAdmin(sender.account)) return 'reject'; // only admins rename the group
      } else return 'reject';
    }
    return 'accept';
  };
}

// ---- who sent an application message ----
// The library authenticates application messages as coming from SOME member but does not say which one, and the server's
// "from" label is not trustworthy. So each message carries the sender's identity and a signature by that device's certified key.
const SIG_LABEL = utf8('vanishgram/v1/group-app');
export function sealApp(sig: SigKeys, groupId: string, account: string, device: string, envelope: Uint8Array, epoch: number): Uint8Array {
  // the epoch travels inside the signed header: a message sent just before a commit arrives after it, when the receiver is already on the next epoch
  const body = utf8(JSON.stringify({ a: account, d: device, e: epoch }));
  const signed = concat(SIG_LABEL, utf8(groupId), u32(body.length), body, envelope);
  return concat(ed25519.sign(signed, sig.priv), u32(body.length), body, envelope);
}
export function openApp(state: ClientState, groupId: string, bytes: Uint8Array): { account: string; device: string; envelope: Uint8Array } {
  if (bytes.length < 68) throw new Error('truncated group message');
  const signature = bytes.slice(0, 64), len = new DataView(bytes.buffer, bytes.byteOffset + 64, 4).getUint32(0, false);
  const body = bytes.slice(68, 68 + len), envelope = bytes.slice(68 + len);
  const who = JSON.parse(fromUtf8(body)) as { a: string; d: string };
  const m = membersOf(state).find((x) => x.account === who.a && x.device === who.d);
  if (!m) throw new Error('message from a device that is not in the group');
  const signed = concat(SIG_LABEL, utf8(groupId), u32(len), body, envelope);
  if (!ed25519.verify(signature, signed, m.sigKey)) throw new Error('group message signature does not match its sender');
  return { account: who.a, device: who.d, envelope };
}

/** Securely forget the old epoch's secrets after a commit of ours was accepted. */
export const release = (consumed: Uint8Array[]) => consumed.forEach(zeroOutUint8Array);

export type Incoming = { kind: 'commit'; state: ClientState } | { kind: 'message'; state: ClientState; plaintext: Uint8Array };
/** Apply a handshake (commit) or application message from another member. Throws if it does not verify. */
export async function receive(state: ClientState, bytes: Uint8Array, policy: IncomingMessageCallback): Promise<Incoming> {
  const impl = await mlsImpl();
  const d = decodeMlsMessage(bytes, 0);
  if (!d) throw new Error('bad mls message');
  const m = d[0];
  if (m.wireformat === 'mls_private_message') {
    const r = await processPrivateMessage(state, m.privateMessage, emptyPskIndex, impl, policy);
    r.consumed.forEach(zeroOutUint8Array);
    if (r.kind === 'newState' && r.actionTaken === 'reject') throw new Error('commit rejected by group policy');
    return r.kind === 'applicationMessage' ? { kind: 'message', state: r.newState, plaintext: r.message } : { kind: 'commit', state: r.newState };
  }
  if (m.wireformat === 'mls_public_message') {
    const r = await processPublicMessage(state, m.publicMessage, emptyPskIndex, impl, policy);
    r.consumed.forEach(zeroOutUint8Array);
    if (r.actionTaken === 'reject') throw new Error('commit rejected by group policy');
    return { kind: 'commit', state: r.newState };
  }
  throw new Error('unsupported mls message');
}

export async function encrypt(state: ClientState, plaintext: Uint8Array): Promise<{ state: ClientState; bytes: Uint8Array }> {
  const r = await createApplicationMessage(state, plaintext, await mlsImpl());
  r.consumed.forEach(zeroOutUint8Array);
  return { state: r.newState, bytes: encodeMlsMessage({ privateMessage: r.privateMessage, wireformat: 'mls_private_message', version: 'mls10' }) };
}

export const saveState = (s: ClientState): Uint8Array => encodeGroupState(s);
export function loadState(bytes: Uint8Array, cfg: ClientConfig): ClientState {
  const d = decodeGroupState(bytes, 0);
  if (!d) throw new Error('corrupt group state');
  return { ...d[0], clientConfig: cfg };
}
