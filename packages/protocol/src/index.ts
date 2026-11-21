// Shared wire constants and limits. Open source: contains no secrets.

/** Domain-separation labels. Never reuse a label for two purposes. */
export const DOMAIN = {
  accountRoot: 'vanishgram/v1/account-root',
  accountAuth: 'vanishgram/v1/account-auth-ed25519',
  accountSync: 'vanishgram/v1/account-sync-key',
  login: 'vanishgram/v1/login',
  deviceCert: 'vanishgram/v3/device-cert',
} as const;

/** Centralised, configurable limits (spec section 14). Server may override. */
export interface Limits {
  maxAttachmentBytes: number;
  maxGroupChannelMemberships: number;
  maxPinnedChats: number;
  maxCollectibleUsernames: number;
  maxBioChars: number;
  maxMessageChars: number;
  maxSignedInAccounts: number;
  inactivityDaysMin: number;
  inactivityDaysMax: number;
  inactivityDaysDefault: number;
  /** Upper bound on ciphertext bytes the server accepts (plaintext cap + overhead). */
  maxCiphertextBytes: number;
  maxGroupMembers: number;
  maxStoredBytesPerAccount: number;
  attachmentTtlDays: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxAttachmentBytes: 1024 ** 3,
  maxGroupChannelMemberships: 250,
  maxPinnedChats: 5,
  maxCollectibleUsernames: 10,
  maxBioChars: 100,
  maxMessageChars: 4096,
  maxSignedInAccounts: 5,
  inactivityDaysMin: 7,
  inactivityDaysMax: 365,
  inactivityDaysDefault: 365,
  // 4096 chars * 4 bytes UTF-8 + padding/envelope/ratchet header/AEAD overhead.
  maxCiphertextBytes: 4096 * 4 + 4096,
  maxGroupMembers: 1000,
  maxStoredBytesPerAccount: 4 * 1024 ** 3,
  attachmentTtlDays: 30,
};

export const USERNAME_RE = /^[a-z][a-z0-9_]{2,31}$/;

/** Plaintext envelope types carried INSIDE the E2EE channel. */
export type Envelope =
  | { t: 'text'; id: string; body: string; replyTo?: string; ts: number; fwd?: string }
  | { t: 'delete-everyone'; target: string; ts: number }
  | { t: 'delete-for-me-sync'; target: string; peer: string; ts: number }
  /** Group sender-key distribution. Sent only over pairwise E2EE sessions, never via the group channel. */
  | { t: 'sender-key'; groupId: string; chainId: string; ck: string; n: number; signPub: string }
  /** Group name/description. Accepted only from owner/admins. Sent pairwise (to newcomers) or in the group channel. */
  | { t: 'group-meta'; groupId: string; name: string; description: string; pinned: string | null; ts: number }
  | { t: 'pin'; target: string | null; ts: number }
  /** Voice call signaling. Carried only inside pairwise E2EE sessions, so the server never sees SDP or ICE. */
  | { t: 'read'; ids: string[]; ts: number }
  | { t: 'edit'; target: string; body: string; ts: number; chat?: string }
  | { t: 'react'; target: string; emoji: string | null; ts: number; chat?: string }
  | { t: 'ttl'; seconds: number; ts: number; chat?: string }
  | { t: 'prefs'; prefs: ChatPrefs; ts: number }
  | { t: 'file'; id: string; file: FileInfo; body?: string; replyTo?: string; ts: number; fwd?: string }
  | { t: 'call-offer'; callId: string; sdp: string; ts: number }
  | { t: 'call-answer'; callId: string; sdp: string }
  | { t: 'call-ice'; callId: string; candidates: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }[] }
  | { t: 'call-end'; callId: string; reason: string; keep?: string }
  | { t: 'call-reject'; callId: string; reason: 'declined' | 'busy' | 'unknown' };

export interface IceConfig {
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  /** True when a TURN relay is configured, so the user can hide their IP address from the other side. */
  relayAvailable: boolean;
}

/** A device's public keys for libsignal (PQXDH + Double Ratchet). The account key certifies the identity key. */
export interface SignedPrekeyWire { id: number; pub: string; sig: string }
export interface DeviceKeysWire {
  deviceId: string;
  /** Coarse description chosen by the device, e.g. "Chrome on Windows". Shown in the device list. */
  label?: string;
  identityKey: string; // base64 serialized libsignal identity public key (33 bytes)
  registrationId: number;
  /** Ed25519 public key this device signs MLS group credentials with. Certified by the account key like the identity key. */
  mlsKey: string;
  cert: string; // base64 Ed25519 signature by ACCOUNT auth key over (device id, identity key, registration id, mls key)
  signedPrekey: SignedPrekeyWire; // signed by the identity key
  kyberPrekey: SignedPrekeyWire; // post-quantum (ML-KEM / Kyber) last-resort prekey, signed by the identity key
  oneTimePrekeys: { id: number; pub: string }[];
}

export interface PrekeyBundleWire {
  accountId: string;
  authPublicKey: string;
  deviceId: string;
  identityKey: string;
  registrationId: number;
  mlsKey: string;
  cert: string;
  signedPrekey: SignedPrekeyWire;
  kyberPrekey: SignedPrekeyWire;
  oneTimePrekey?: { id: number; pub: string };
}

/** Ciphertext message as the server sees it. Everything inside `body` is opaque. */
export interface WireMessage {
  id: string; // server-visible message id (random, used for purge/ack)
  from: string; // sender account id (metadata, visible to server)
  fromDevice: string;
  toDevice: string;
  body: string; // base64 ciphertext envelope
  ts: number; // server receive time
  group?: string; // set for group-channel messages
  /** MLS group handshake traffic: a commit for existing members, or a welcome for a new device. Absent for ordinary messages. */
  mls?: 'commit' | 'welcome';
}

/** MLS key packages are one-time invitations a device leaves on the server so others can add it to groups. */
export interface KeyPackagesUpload { packages: string[]; lastResort?: string }
export interface KeyPackageClaim { deviceId: string; keyPackage: string; lastResort: boolean }
export interface GroupCommitUpload { epoch: number; commit: string; welcomes: { toAccount: string; toDevice: string; welcome: string }[] }

/** Everything a recipient needs to fetch and decrypt an attachment. Lives only inside E2EE envelopes. */
export interface FileInfo {
  fileId: string; name: string; mime: string; size: number; kind: 'image' | 'video' | 'audio' | 'voice' | 'file';
  key: string; chunkSize: number; chunks: number; hash: string; // chunkSize is the PLAINTEXT chunk size
  thumb?: string; w?: number; h?: number; duration?: number; wave?: number[];
}
export const FILE_PLAIN_CHUNK = 1024 * 1024;

/** Chat organisation, synced end-to-end encrypted between a person's own devices. */
export interface ChatPrefs {
  pinned: string[]; archived: string[]; muted: string[];
  folders: { id: string; name: string; chats: string[] }[];
  ts: number;
}

/** OPAQUE (cloud password): both sides must use the same identifiers and key stretching. */
export const OPAQUE_SERVER_ID = 'vanishgram';
export const OPAQUE_KEY_STRETCHING = { 'argon2id-custom': { iterations: 3, memory: 64 * 1024, parallelism: 1 } } as const;
