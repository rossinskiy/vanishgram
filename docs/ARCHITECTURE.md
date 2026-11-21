# Vanishgram: architecture, threat model, roadmap

Status legend: **[done+tested]**, **[partial]**, **[planned]**. Nothing here is independently security-reviewed.

## 0. Contradictions in the requirements (decisions taken)

| # | Requirement conflict | Decision |
|---|---|---|
| 1 | "Server stores encrypted messages while B still needs them" vs. per-device ratchet E2EE | Server is a **store-and-forward queue**: row deleted on delivery ack. Long-term history lives on devices (plus optional client-encrypted backup, planned). "Delete for me" is therefore client state synced to own devices by encrypted control messages. The "both deleted, server removes" rule applies to queued messages and attachments, not to a history archive that does not exist. |
| 2 | Recovery phrase is the only recovery path vs. per-device message keys | The phrase restores **identity** (account key, username, contacts list sync key), not past messages. New device = new device keys + new sessions. History transfer needs a trusted old device or an encrypted backup. |
| 3 | 12-word phrase (128 bit) vs. offline brute force | 128 bits is infeasible to brute force. The danger is phrase theft, not guessing. PBKDF2 in BIP-39 adds nothing against a 128-bit secret and is kept only for standard compatibility. |
| 4 | TOTP / cloud password as 2FA vs. "phrase never sent to the server" | TOTP secret and cloud password are checked **by the server**, so they protect against stolen phrase use via the server but NOT against a compromised server, and they cannot protect E2EE content. The cloud password uses OPAQUE (aPAKE), so the server never sees it or anything checkable offline. [done] |
| 5 | Anonymous registration vs. spam resistance | Proof-of-work per registration + per-IP limits now; anonymous credentials (Privacy Pass style) later. No phone/email by design, so abuse resistance is weaker than Telegram/Signal. Accepted trade-off. |
| 6 | Public channels vs. "server never sees plaintext" | Public channel posts are plaintext by design and stored as such. Private channels use MLS-style group keys. The two are separate tables and separate API namespaces. [planned] |
| 7 | Mandatory inactivity deletion vs. recipient history | Deleting an account never deletes queued mail addressed to other accounts. Verified by test. |
| 8 | 1 GB attachment vs. 4096-char limit "without plaintext access" | Server limits are on ciphertext **bytes** (`maxCiphertextBytes`), client enforces character limits. Padding blocks hide exact length. |
| 9 | Closed server vs. "independent review" | Wire protocol, schemas of what the server learns, and this document are public. Security must not depend on server secrecy. |

## 1. System architecture (small-team, no microservices)

```
client (open source, GPL-3.0-or-later proposed)       server (closed, single deployable)
 ├─ packages/protocol    constants, limits, wire types ├─ HTTP/JSON + WebSocket
 ├─ packages/client-core client, libsignal bridge     ├─ MongoDB (own instance, replica set)
 └─ (UI apps)            planned: web, React Native    ├─ Redis for rate limits/pubsub at >1 node [planned]
                                                       └─ S3-compatible store for encrypted blobs [planned]
```

Stack choice: TypeScript end to end for the first slice (one language, shared protocol types, fast iteration). The server is isolated behind the HTTP/WS protocol, so a Rust port is possible if load demands it. Not chosen yet: Go/Rust (not installed locally, slower to a working slice).

## 2. Cryptography

| Purpose | Mechanism | Status |
|---|---|---|
| Recovery phrase | BIP-39, 128 bit entropy, 12 words | done+tested |
| Account keys | HKDF-SHA256 from BIP-39 seed with domain labels (`account-root`, `account-auth-ed25519`, `account-sync-key`) | done+tested |
| Account ID | first 128 bit of SHA-256(auth public key). Self-certifying, so the server cannot swap keys | done+tested |
| Login | Ed25519 signature over `login|accountId|server nonce`; single-use 60 s nonces; uniform failure; phrase never sent | done+tested |
| Device keys | per-device Ed25519 + X25519, **certified by the account key**; clients verify the chain on every bundle | done+tested |
| Session setup | **PQXDH** (X25519 plus Kyber/ML-KEM, signed prekey, one-time prekey, last-resort Kyber prekey) in the official **libsignal** | done+tested |
| Messages | Double Ratchet in libsignal, 256-byte padding added by us, every device identity certified by the account key, nothing from an uncertified identity is ever trusted; engine calls are serialized so overlapping sends cannot reuse a counter | done+tested |
| Replay | consumed message keys, counter check, one-time prekeys deleted on use | done+tested |
| Local storage | Vault: Argon2id (64 MiB, t=3) to ChaCha20-Poly1305, header as AAD, KDF floor on open, atomic write, one vault + key per account; state persisted BEFORE send and BEFORE ack | done+tested (Node file backend; IndexedDB backend planned) |
| Multi-device | per-device fan-out | partial: peer fan-out works, own-device history sync and sent-message mirroring missing |
| Verification | safety number helper exists | partial: no UI |
| Groups | Sender-key chains over pairwise E2EE (not MLS yet) | done+tested, see Private groups |
| Attachments | random key per file, 1 MiB chunked AEAD, key sent inside the ratchet | done+tested |
| Calls | WebRTC + DTLS-SRTP, signaling over ratchet-encrypted messages, verification code | done+tested (Chrome), no TURN relay yet |

**Caveat:** pairwise encryption is now Signal's own library (`@signalapp/libsignal-client`, AGPL-3.0), which has been audited by others; our integration (device certificates, trust rules, state persistence, the bridge) has not. Group sender keys, OPAQUE integration and the rest of the client are still unreviewed. The earlier home-made ratchet was removed.

## 3. What the server can see (metadata)

Visible: account IDs, device IDs, public keys, usernames, who messages whom and when, ciphertext size (padded to 256 B), IP addresses (unless fronted by a relay/Tor), last-active time, online state.
Not visible: message text, envelope type (text vs delete), recovery phrase, device private keys.
Logging rule: request bodies and tokens are never logged (the 500 handler logs only the error class). Tokens are stored as SHA-256 hashes.

## 4. Deletion semantics

* **Delete for me [done+tested]:** removed locally; encrypted `delete-for-me-sync` goes to own other devices; peer unaffected; server queue entry is already gone after ack.
* **Delete for everyone [done+tested]:** sender tombstones the id, purges queued ciphertext (`DELETE /v1/messages/:id`, sender-only), sends an encrypted `delete-everyone`. Receiver accepts it only for messages that **peer** sent. Tombstone blocks a late-arriving copy. Offline devices get the event from the queue on reconnect.
* **Not guaranteed:** screenshots, copies on compromised or modified clients, notifications already shown, backups made by users. The UI must say so.
* Open: tombstone persistence and sync to new devices; cryptographic erasure of server-side encrypted backups [planned].

## 5. Account lifecycle

Inactivity days 7..365 (default 365, cannot be disabled) [done+tested]. **Activity** = any authenticated HTTP request or WebSocket frame; unauthenticated traffic does not count. `purgeInactive()` runs hourly; deletion cascades devices, prekeys, sessions, usernames, and mail addressed to that account; every deletion writes an audit row (id, reason, time). Mail the deleted account sent to others stays queued. Username release policy: names are freed immediately (a cooldown against re-registration impersonation is planned).

## 6. Anti-abuse (anonymous)

Done: PoW on registration (default 18 bits), per-IP/per-account rate limits on register, login, challenge, lookup, prekey fetch, message send; reserved usernames; size caps; one-time prekey fetch is rate limited to limit prekey exhaustion. Planned: reporting (client-forwards the reported plaintext voluntarily), reputation, anonymous credentials, temporary/permanent restrictions, block lists enforced at the server by account ID.

## 7. Threat model (short)

| Adversary | Protected | Not protected |
|---|---|---|
| Passive network | TLS (deployment) + E2EE | traffic analysis |
| Malicious/compromised server | content, key substitution (cert chain to account ID) | metadata, availability, withholding/dropping messages, first-contact key substitution on a **brand-new** account until users compare safety numbers |
| Stolen device | vault encrypted with passphrase (Argon2id) | weak passphrase, malware on unlocked device, RAM contents while running |
| Stolen phrase | nothing: phrase = identity (2FA on server limits use, planned) | |
| Malicious user | rate limits, PoW | spam of new anonymous accounts |
| Insider admin | no decryption path exists in the code | metadata |

## 8. API (v1, implemented)

`GET /v1/pow`, `POST /v1/register`, `POST /v1/auth/challenge`, `POST /v1/auth/login`, `POST /v1/auth/logout`, `PUT /v1/devices`, `POST /v1/prekeys`, `GET /v1/accounts/:id/devices`, `GET /v1/accounts/:id/prekeys`, `PUT|GET|DELETE /v1/usernames[/:name]`, `POST|DELETE /v1/messages[/:id]`, `PUT /v1/account/inactivity`, `DELETE /v1/account`, `GET /v1/limits`, WebSocket `/v1/ws` (token in `Sec-WebSocket-Protocol`; events `message`, `ack`, `typing`).

## Private groups (implemented)

**Design: MLS (RFC 9420) for private groups.** Each member DEVICE is a leaf of an MLS ratchet tree (`ts-mls`, ciphersuite X-Wing: X25519 plus ML-KEM-768, AES-256-GCM, Ed25519). Every membership change is a commit that starts a new epoch with fresh keys, so a removed member cannot read anything after it and members heal after a compromise. The server stays the roster authority and the delivery service: it decides who belongs and enforces roles; clients turn that into commits. Any member device that sees a gap between roster and tree (someone joined, was removed, signed in on a new device, signed a device out) builds the commit; the server accepts exactly one commit per epoch (`POST /v1/groups/:id/commit`, 409 `epoch moved` for the loser, who rebuilds on the winner's commit). New members get a Welcome; their devices leave one-time **key packages** on the server (`/v1/keypackages`; a last-resort package is used only when the one-time ones run out).
* **Credentials:** a leaf's credential is `account:device`, and its signature key must be the `mlsKey` the account certified for that device (the same account-key certificate chain as the pairwise identity). The library calls our check for every credential, so the server cannot slip in its own key package.
* **Policy against hostile members:** every incoming commit is checked against the server-enforced roster: Adds only for accounts the server admitted, Removes only for devices that are gone (or the committer's own), group-info changes only from admins. Anything else is rejected.
* **Who wrote it:** the library authenticates "some member" but does not say which. Each message carries the sender's account and device and a signature by that device's certified MLS key, checked against the tree; the server's `from` label is not trusted.
* **Group info** (name, description, pinned message) lives in a GroupContext extension, so it travels in the Welcome and changes only through an admin's commit. The server cannot read it.
* **Late messages:** the client keeps keys for the last four epochs, so a message sent just before a commit still opens after it.
* **Limits:** the library has not been independently audited. A device that fails to apply a commit is not repaired automatically (it can be added again). Commits and welcomes carry the member tree, so very large groups are heavy; private CHANNELS keep the older sender-key design on purpose, because MLS would show every subscriber the identity of the others.

**The older design (still used for private channels): sender keys.** Each member device owns a symmetric chain (HMAC ratchet plus an Ed25519 signing key). A message is encrypted once with the chain and signed, then the server fans the single ciphertext out to every member device. Chains are handed to other members only through the pairwise sessions. Nothing about group content is visible to the server.

**What the server knows:** group ID, the roster with roles, who posts and when, ciphertext size. **What it does not know:** name, description, pins, message text. Those travel as encrypted envelopes (`group-meta`, `pin`, `text`), and receivers accept `group-meta` and `pin` only from an owner or admin according to the server roster.

**Membership changes:** every change bumps a roster revision and queues a `group-event` for each member device (also for the removed account), so offline members catch up. On an event each client fetches the roster and diffs it. Anyone who left or was removed causes every remaining member to start a fresh chain and distribute it only to the current members. The server also drops queued group ciphertext for the removed account and stops fanning out to it. A removed member keeps what they already decrypted, as with any E2EE group.

**Roles:** owner (one), admins, members. Admins add or remove members, rename, pin, create invite links, delete any message. Only the owner changes roles, transfers ownership or deletes the group. The owner cannot leave without transferring. When an owner account is deleted, ownership passes to the oldest admin, else the oldest member; an empty group is removed.

**Invite links:** `https://host/#join=<groupId>.<token>`. The token is a bearer secret kept in the URL fragment (never sent to the server except in the join call) and stored server-side only as a hash. Default 7 days and 50 uses, revocable, rate limited, one error message for every failure.

**Limits:** 250 group/channel memberships per account (shared limit), 1000 members per group (`maxGroupMembers`), 10 group creations per hour, 60 member additions per hour.

**Weaker than MLS, on purpose for now:**
* No post-compromise security inside a chain: if a device is compromised, the attacker reads that device's chain until the next rotation. Rotation happens on removals only. A periodic rotation is not implemented.
* Rotation cost is O(members squared) pairwise messages after a removal. Fine for tens of members, painful for hundreds.
* The roster and roles are trusted from the server. A malicious server can lie about who is an admin (affecting names and pins, not secrecy) and can silently add a member it controls. Mitigation planned: signed membership changes and key verification prompts.
* A member's brand-new device cannot read group messages until the other members next distribute keys (a roster change triggers it). Own-device sync is not built.
* New members get no history by design.
* Sender-key distribution relies on the pairwise sessions. Simultaneous first contact between two accounts is handled by keeping several sessions per peer device (tested).

## Channels (implemented)

Two kinds with different privacy models. The UI says which one you are looking at.

**Public channel: plaintext by design.** Posts are stored on the server and readable by any signed-in account, with or without subscribing. Each channel has a username (one namespace shared with people, so nobody can impersonate by picking the other kind), a title and description, pinned post, subscriber count, and a per-post view counter (one view per account per post, deduplicated by the server). Posts are delivered live over the WebSocket to online subscribers; offline subscribers reconcile the newest 50 posts on reconnect, including edits and deletions. Posts show no author account to non-admins. Admins can edit and delete posts, pin, rename; only the owner changes the username. Subscribers appear to admins only. Do not put anything confidential in a public channel: the operator, anyone with an account and any scraper can read it.

**Private channel: an E2EE group where only admins post.** Reuses the group machinery (sender-key chains, rotation on removal, invite links) with these differences: subscribers hold no chain and send nothing; the server returns subscribers only the admin list plus a count, so subscribers cannot see each other; joins and leaves are announced to admins only (admins hand new subscribers the keys), while role changes and deletion go to everyone; the server rejects posts from non-admins and clients ignore envelopes from non-admins anyway. The server cannot read posts, titles or descriptions.

**Roles and limits:** owner, admins, subscribers. A channel is never handed to an arbitrary subscriber when its owner account disappears: an existing admin inherits it, otherwise the channel is deleted. Subscriptions count toward the shared 250 group/channel membership limit. Channel creation is limited to 5 per hour, subscription to 60 per hour, search and lookup are rate limited.

**Notification settings:** per-chat mute, stored encrypted on the device (the server is not told).

**Known gaps for channels:**
* No view counters for private channels: counting would need either a server-visible signal or signed receipts that leak who read what.
* No avatars, no comments or reactions, no scheduled posts, no editing of private-channel posts.
* Public channel read access requires an account (no anonymous web preview yet), which limits scraping but is not a privacy promise.
* Private channel rekeying after a removal costs one pairwise message per admin per remaining subscriber. Fine for hundreds, too heavy for tens of thousands; large private channels need a different design (MLS or a relay-side tree).
* Discovery search is a prefix/substring match on username and title with no ranking or abuse reporting yet; there is no report button and no moderation tooling for public channels.
* Subscribers of a public channel are visible to its admins by account ID.

## Voice calls (implemented)

**Transport and encryption.** WebRTC with DTLS-SRTP (AES-128 CTR plus HMAC-SHA1-80, negotiated by the browser). SDP offers and answers, which contain the DTLS certificate fingerprints, and ICE candidates travel only inside pairwise E2EE sessions (the same Double Ratchet that carries messages). The server relays opaque ciphertext and cannot replace a fingerprint, so the audio is end-to-end encrypted between the two devices, including when a TURN relay is used. Both sides also show a **call code** derived from the two fingerprints; reading it aloud confirms no one sits in the middle.

**What the server sees and stores.** It sees that an encrypted message went from account A to account B at a time, like any message. It does not see SDP, IPs, call type, duration or outcome, and it stores no call records: signaling rows are deleted as soon as the device acknowledges them. Nothing records or transcribes audio. Call history exists only as local notes in each user's own chat ("Voice call, 2:31", "Missed voice call").

**Behaviour.**
* One-to-one only. Ring timeout 45 s. Answer, decline, hang up, cancel, mute, speaker selection where the browser supports `setSinkId`, live duration, connection status, reconnect grace of 10 s.
* The callee's microphone is not opened until the call is answered.
* A person you have no chat with cannot make your device ring (they must write first). Offers older than the ring timeout become a "Missed voice call" note; call IDs are single use.
* Several devices on one account all ring; when one answers or declines, the others stop (encrypted notice to the account's own devices).
* If you are already in a call, a new caller gets "line busy".

**IP address exposure.** In a direct peer-to-peer call each side learns the other's IP address (visible in ICE candidates). The call screen says so. When the server has a TURN relay configured (`VG_TURN_URLS` plus `VG_TURN_SECRET`, coturn "use-auth-secret" style, ephemeral credentials valid about one hour and not tied to an account), Settings offers "Hide my IP address" which forces relay-only mode. **No relay is configured on vanishgram.karatel.win yet**: the VPS sits behind a Cloudflare Tunnel (HTTP only, no public UDP) and has no root access, so a TURN server must run on a separate host with a public IP. Until then calls use STUN (default `stun:stun.cloudflare.com:3478`, override with `VG_STUN`) and can fail between devices behind strict or symmetric NATs.

**Not done.** Group calls, video, screen sharing, call history sync across devices, push notifications for calls when the tab is closed (a call only rings while the app is open and connected), glare handling when two people call each other at the same instant (both get "line busy"), echo and quality tuning beyond the browser defaults, and real-device testing on Safari and mobile browsers. The WebRTC path was verified in Chrome with two accounts in one page and a synthetic tone (`apps/web/e2e/`): DTLS connected, SRTP in both directions, matching codes, mute and hang-up.

## Profile, privacy and blocking (implemented)

**Profile.** Display name (64 chars), bio (100 chars, enforced by the server), avatar. The avatar is cropped to a 256 px square and re-encoded in the browser, which strips EXIF data such as GPS; the server accepts only PNG, JPEG or WebP under 200 KB (checked by file signature) and serves it with `nosniff` and a locked-down CSP. **Profile data is stored on the server in plaintext** so others can see it: it is not end-to-end encrypted, and the UI says so.

**Privacy settings** (stored server-side because the server must enforce them): who sees last online (everyone, people I have written to, nobody), who sees photo/name/bio, who can add me to groups and channels, who can message me, typing indicator on/off, read receipts on/off. "People I have written to" is the server's only notion of a contact: it already sees who messages whom, so it records `a has written to b` and no more. Presence is coarse on purpose: "online", "recently" (under 3 days), "this week", "long ago".

**Blocking is silent.** A blocked account's messages return success, nothing is queued, typing is not relayed, group additions fail with the same generic error as a restricted-invite person, and their view of your profile and presence looks the same as a stranger's. They are never told. Blocking also drops mail they had already queued for you. Limits: a blocked person can still see that your username exists, and group or channel membership you share is not changed by a block.

**Read receipts** are an encrypted envelope sent by the reader's device only if the reader allows it; the server cannot see them. There is no delivery tick yet.

**Not done.** Per-contact privacy exceptions, "who can call me" as a separate setting, reporting of abuse, profile photo history, and hiding the existence of a username from blocked accounts.

## Two-step verification (implemented)

**What it does.** With it on, the 12-word phrase alone no longer gives a session. A sign-in on a NEW device needs every enabled factor. An already signed-in device keeps working: its stored session is reused when the vault is unlocked, so you are not asked each time. Message encryption is independent of it.

**Authenticator app (TOTP, RFC 6238).** HMAC-SHA1, 6 digits, 30 s, one step of clock drift allowed, each step usable once (replay is rejected). Works with Google Authenticator, Microsoft Authenticator and other standard apps; the setup screen shows a QR code and the key. The test suite checks the RFC test vectors.

**Recovery codes.** Ten one-time codes shown once at setup, stored only as hashes. A recovery code replaces the authenticator code, not the password. Turning off the authenticator or regenerating codes needs a valid authenticator or recovery code.

**Cloud password (OPAQUE).** Implemented with `@serenity-kit/opaque` (the Rust `opaque-ke` library compiled to WASM; same identifiers on both sides: account id and `vanishgram`). The password never leaves the device. Registration and login are two-message exchanges; Argon2id key stretching (64 MiB, 3 passes) runs on the device inside the exchange. The server stores only an OPAQUE registration record. Its long-term OPAQUE secret lives in `data/opaque.setup` (mode 600, never in the database), so a database leak alone gives an attacker nothing to attack offline. A wrong password is noticed on the client, so the server cannot count failed finishes; instead it charges every exchange it **starts** against the same escalating lockout as TOTP, which keeps online guessing slow. Changing or removing it needs the current password, proved by a fresh OPAQUE exchange. **It cannot be reset: forget it and the account is locked, until inactivity deletion removes it.** This is a deliberate trade-off: a reset path would be a bypass. The web page needs `wasm-unsafe-eval` in its CSP for the WASM module (nothing else is relaxed).

**Brute-force protection.** Second-step attempts are rate limited, and after 5 failures the account locks for 1, 2, 4, ... minutes up to 24 hours. Only someone who already passed the phrase signature reaches this step, so an outsider cannot lock the owner out. Failures all return the same message.

**Honest limits.**
* OPAQUE removes the password-equivalent value from the wire and the database, but the library is a third-party build (opaque-ke by way of a WASM wrapper) and this integration has not been independently reviewed. The TOTP secret is still readable by the server (a code must be checked against it).
* The server stores the TOTP secret in plaintext (it has to verify codes). A compromised server defeats TOTP.
* Neither factor protects against malware on a device that is already signed in, or against someone who also has an unlocked device.
* Recovery when the authenticator and all recovery codes are lost, or the cloud password is forgotten, does not exist by design. Write the codes down.
* There is no "sign out other devices" or device list screen yet. Signing out on a device now removes it and its queued mail from the server.

## Attachments (implemented)

**Encryption.** The device splits a file into 1 MiB chunks and seals each with ChaCha20-Poly1305 under a random 32-byte per-file key. The key never reaches the server: it travels inside the E2EE message envelope together with the file ID, name, type, size and a hash over all chunk hashes. Each chunk's associated data binds the file ID, chunk index and chunk count, so chunks cannot be reordered, swapped between files or silently cut short. Small encrypted thumbnails (48 px, under 6 KB) travel inside the envelope too.

**Upload.** Up to 1 GB, chunked, 3 chunks in flight, with retry and back-off per chunk. Every chunk carries its SHA-256 and the server rejects a mismatch. Uploads are resumable: the device keeps the key and metadata in its encrypted vault, so a restarted upload re-encrypts to identical ciphertext and sends only the chunks the server lacks (`GET /v1/uploads/:id` lists them). The UI shows progress and lets you cancel.

**Download.** Chunk by chunk, each verified and decrypted on the device. Images up to 8 MB load inline, video and audio on tap, other files on tap. Large files stream to disk with the File System Access API where the browser offers it; otherwise they are assembled in memory (a 1 GB file in a browser without streaming needs that much RAM).

**Server-side rules.** Only holders of a reference can download; the uploader and anyone already holding a file can share it onward (forwarding). References are per account, so deleting for yourself releases only your access. A file is removed when its last reference goes, on delete for everyone (uploader only), when the 30 day lifetime ends, 2 hours after upload if it was never attached to a message, and 24 hours after an unfinished upload was abandoned. Per account storage is capped at 4 GiB and three unfinished uploads. When the uploader's account is deleted, people the file was shared with keep it until they release it or it expires. Limits are in `Limits` (`maxAttachmentBytes`, `maxStoredBytesPerAccount`, `attachmentTtlDays`).

**Known limits.** No attachments in public channels (their posts are plaintext by design). A recipient who never opens the app loses the file after 30 days. Seal plus hash runs at about 120 MiB/s in the browser, so 1 GB costs roughly 8 seconds of CPU. No server-side virus scanning is possible: the server cannot read files.

## Chat features (implemented)

**Editing, reactions, forwarding.** Edits and reactions are encrypted envelopes. Only the original author can edit (receivers check the sender). One reaction per person per message. Forwarding sends a normal message with a "Forwarded from" label; files are forwarded by sharing the same encrypted file with the new recipient.

**Delivery and read status.** One tick means the server accepted the message, two ticks mean the recipient's device confirmed receipt (the server tells the sender's device; it already knew this), a read mark comes from an encrypted receipt and only if the reader allows it. Messages dropped because of a block never get a delivered mark, so blocking stays invisible.

**Disappearing messages.** Per chat timer (30 seconds, 1 hour, 1 day, 1 week) agreed through an encrypted envelope; in groups only admins can set it. Messages sent afterwards carry an expiry and each device deletes them (and releases attached files) when it passes. It is deletion on honest clients: it cannot remove screenshots or copies on modified clients.

**Organisation.** Pinned chats (up to 5), archive (a new message from an unmuted archived chat brings it back), folders, mute. They sync to your other devices through an encrypted envelope; the server sees none of it. Drafts and the saved-messages chat live in the encrypted vault (saved messages mirror to your other devices). Search runs on the device over decrypted history, accent and case insensitive, including file names.

**Voice messages.** Recorded in the browser (Opus in WebM or Ogg), sent as an encrypted attachment with duration and a 40-bar waveform; playback is inline with seeking.

**Not done.** Multiple accounts in one browser, scheduled messages, polls, stickers, per-message translation, message history sync to a brand-new device, and syncing drafts between devices.

## Interface

Telegram-like density with Vanishgram's own look: white, blue and coral. Blue carries action and your own messages, coral carries attention (unread, the microphone, your reactions). Chat list with folder tabs, pinned chats, typing and draft previews and ticks; bubbles with tails and grouping; wallpaper drawn in CSS with brand glows; a slide-in menu; a combined reaction and action menu; inline images, video, voice and file cards with progress rings; drag and drop and paste to attach. Light by default, dark on request, one pane at a time on phones, motion removed under `prefers-reduced-motion`. No emoji stand in for icons (reactions are the only emoji, because they are user content).

## Several accounts on one device (implemented)

Up to 5 accounts (`maxSignedInAccounts`) can be signed in at once. Each has its own IndexedDB vault, its own passphrase, its own keys and its own server connection, so nothing is shared between accounts: separate `VanishClient` objects, separate encrypted storage records, no common key. Unlocked accounts stay online in the background and count unread messages (drawer badges, the tab title, and per-chat counts when you switch); a locked account shows as locked until you enter its passphrase. The drawer switches accounts, adds one (create or recover; the same account cannot be added twice) and signs out of one or of all. Per-account second factors apply as usual.

Limits: no desktop notifications yet, a background account does not ring for calls (they time out as missed), and signing out of a locked account removes its local data but cannot remove its device entry from the server until it is unlocked once.

## Devices, reports and restrictions (implemented)

- `GET /v1/devices` lists devices (label, last seen). `DELETE /v1/devices/:id` and `POST /v1/devices/revoke-others` sign devices out; the revoked device's sockets are closed (code 4002) and it shows a "session ended" dialog.
- `POST /v1/reports` takes spam/abuse/other reports. Plaintext evidence is stored only if the reporter attached it and consented. 5 distinct reporters in 24 h put an account in `limited` for 24 h automatically. A limited account cannot start new conversations, create groups/channels or upload files.
- New-conversation limits per hour (stricter for new accounts). Replies in an existing pair are never limited.
- Operators: `node server/scripts/moderate.ts <db> reports|report|resolve|account|restrict|unrestrict|ban|unban`. Bans persist in `bans` and block register/login. Reports are purged by the janitor.
- Browser notifications are opt-in and show no message text by default.

## Operations (implemented)

- `GET /v1/health` is public. `GET /v1/metrics` (Prometheus text) needs `VG_METRICS_TOKEN` and returns 404 otherwise. Metrics hold counts, durations and sizes by route only, never ids, IPs or content.
- Load test: `node server/scripts/loadtest.ts`. Baseline (in-process, 40 clients with real E2EE, so the clients' own crypto shares the CPU): about 193 msg/s end to end on a fast desktop, about 26 msg/s on the production VPS with both the old SQLite layer (27) and MongoDB (26). The limit is client-side cryptography, not the database; the run also prints the server-side time per route.
- CI (`.github/workflows`): type check, tests, `npm audit`, CodeQL; Dependabot weekly.
- Licences: client packages GPL-3.0-or-later, server proprietary (`server/LICENSE`).

## Calls without exposing server IPs

`/v1/calls/ice` returns Cloudflare Realtime TURN credentials when `VG_CF_TURN_KEY_ID` and `VG_CF_TURN_API_TOKEN` are set (cached 20 min, last good set reused if Cloudflare is down). Relayed media goes through Cloudflare, so peers never learn the server's address. Without keys, plain STUN is used.

## Pairwise encryption on libsignal (implemented)

* `packages/signal-engine` wraps libsignal (native Node module) behind the `SignalProvider` interface defined in client-core. Identity, signed prekey, Kyber prekey, one-time prekeys and sessions live inside the engine; `save()` returns them as bytes that go into the passphrase-encrypted vault.
* In the desktop app the engine runs in the **main process**. The sandboxed interface reaches it over a bridge that exposes a fixed list of methods and only to our own bundle (`apps/web/src/signal-bridge.ts`, `apps/desktop/main.cjs`). The page never holds ratchet or identity keys. Tests run the engine directly in Node.
* Device certificate: the account Ed25519 key signs (device id, identity key, registration id). Prekeys are signed by the device identity key (checked by the sender, not the server). A device id is bound to one identity key for life; the server refuses to change it.
* Trust: the identity store only trusts a key the client registered after verifying the certificate chain. A prekey message from any other identity key is refused.
* Wire format: `base64(type byte || libsignal message)`, type 3 for the first (pre-key) message, 2 afterwards. The signed and Kyber prekeys rotate weekly; the last three are kept for late first messages.
* Not wire compatible with the earlier home-made protocol. Existing vaults keep their chats and group state but get a fresh device identity on next start; the server's old device records and queued mail were cleared at the switch.
* Licence: libsignal is AGPL-3.0, so the desktop app and the engine are AGPL-3.0-only. Source must be offered to everyone who gets the installer.
* Private groups moved to MLS (see Private groups). Our own sender-key chains remain only for private channels and travel inside these pairwise sessions.

## Desktop app and website (implemented)

There is no web messenger. The interface runs inside an Electron app (`apps/desktop`) for Windows, macOS and Linux, and the website (`apps/landing`) is a landing page with downloads. Reason: a website can change its JavaScript on every visit, and that JavaScript holds the keys; an installed app cannot be swapped by the server, and it can use native cryptography libraries that do not run in a browser.

* The interface bundle ships inside the installer and is loaded from `app://vanishgram`. The window enforces its own CSP: scripts only from the bundle (plus `wasm-unsafe-eval` for OPAQUE), network only to the Vanishgram API host, Cloudflare STUN/TURN. A test shows other hosts are blocked.
* Security settings: `contextIsolation`, `sandbox`, no Node in the page. The preload exposes only the app version and a deep-link callback. Navigation is locked to the bundle; `https` links open in the normal browser. Permissions: microphone and notifications for our own pages only.
* The API allows cross-origin calls from `app://vanishgram` and from no other origin (CORS allow-list, covered by a test).
* Deep links: `vanishgram://open#join=...` and `#channel=...` open invites. Invite links on the website show an "Open in Vanishgram" button.
* Installers are not code signed. Windows SmartScreen and macOS Gatekeeper warn on first launch; the website says so and publishes SHA-256 sums. There is no auto-update yet, so a new version means downloading again.
* Builds: Windows `.exe` (NSIS) can be built on Windows. The Linux AppImage needs a Linux machine. The macOS `.dmg` needs macOS. `.github/workflows/desktop.yml` builds all three.
* The server serves installers from an allow-list at `/download/Vanishgram-*` (`VG_DOWNLOAD_DIR`); the landing build lists real file sizes and checksums.

## Phone apps (implemented)

Android and iPhone apps (`apps/mobile`) wrap the same interface bundle with Capacitor, so the interface ships inside the app and the website cannot swap it. As on desktop, the keys never live in the page: pairwise encryption runs in native code behind the same `SignalProvider` bridge.

* **Native libsignal.** `packages/capacitor-signal` is a Capacitor plugin with two ports of `packages/signal-engine`: Java on `org.signal:libsignal-android` and Swift on `LibSignalClient`. All three engines use the same state format and the same PQXDH and Double Ratchet code from Signal. The interface reaches the plugin through `window.Capacitor.Plugins.VgSignal` (`apps/web/src/signal-bridge.ts`); byte arrays cross as `{"$u8": base64}`.
* **Tests.** The Java engine was checked against the Node engine on a desktop JVM (both directions, shared state files, replay refusal). CI runs the real Android app in an emulator and drives the engine from the page (`apps/mobile/android/app/src/androidTest`), and runs the Swift engine in the iOS simulator through the same JSON bridge (launch argument `-vg-selftest`).
* **Origins.** The apps run from `https://app.vanishgram.invalid` (Android) and `capacitor://app.vanishgram.invalid` (iOS), a reserved host that never resolves. The API allows CORS from exactly those two origins and from `app://vanishgram`.
* **Page policy.** A Content-Security-Policy meta tag (same rules as the desktop window) is added at build time by `apps/mobile/scripts/prepare-www.mjs`. Android backups are off, so the encrypted vault is not copied to the cloud.
* **Builds and signing.** `.github/workflows/mobile.yml` builds an unsigned Android bundle and APK and an unsigned iOS `.ipa`. No signing key is in CI. `scripts/sign-android.mjs` signs on the maintainer's computer: the `.aab` for Google Play with the upload key, the `.apk` with v2 and v3 signatures. The `.ipa` stays unsigned: AltStore or Sideloadly re-sign it with the user's own Apple ID (7-day validity with a free account). App Store distribution needs a paid Apple developer account and is not done.
* **Not built yet.** Push notifications (messages arrive while the app is open), automatic updates for the APK and the iOS build, deep links into the phone apps, and the App Store.

## Updates, history transfer, group repair (implemented)

* **Self-update (Windows and Linux).** The app checks `/updates/release.json` at start and every 6 hours. The server only hosts files. `release.json` lists the version and the sha512 of every file and is signed with an Ed25519 key that lives on the maintainer's computer (`~/.claude/vanishgram-release/`, never on the server or in the repository); the public key is built into the app (`apps/desktop/update-key.cjs`). The app downloads a new version only if its file hashes appear in a correctly signed list, and electron-updater then verifies the download against the same hashes. So a compromised server cannot push code. Release steps: tag, let GitHub Actions build, download the artifacts, run `node scripts/release.mjs <artifacts> <out>` (signs), upload `<out>` to the server's downloads folder. macOS builds are unsigned and cannot update themselves; the website offers the new dmg.
* **History transfer.** A device that has just signed in with the phrase sends `history-request` to the account's other devices through the normal pairwise channel. The older device asks its owner for approval. On approval it packs chats, contacts, tombstones and chat organisation, encrypts that as a file under a fresh key (the existing attachment code), and sends the file reference to the requesting device only. Keys never move; the new device has its own. Deleted-for-everyone messages stay deleted. Requests from anyone but the account's own devices are ignored.
* **Group repair.** A device that fails to apply an MLS commit (anything but a policy rejection) drops its state for that group and posts `hello` with `resync`. The server relays that in a group event; any member's device then removes the stale leaf and adds a fresh key package for the same device in one commit. Receivers accept the removal only because the same commit adds the same device again.
* **macOS** builds exist for Apple Silicon and Intel (unsigned).

## 9. Deployment (vanishgram.karatel.win)

Target: VPS `tsar@server`, code in `/home/tsar/projects/vanishgram`, pm2 process with cwd inside that folder, Node 24 required. Server listens on `127.0.0.1` only (`HOST`, `PORT`), env `VG_TRUST_PROXY=1`, `VG_MONGO_URI` and `VG_MONGO_DB` (credentials are read from a 600 file outside the web root). nginx terminates TLS (certbot) and proxies `/` including WebSocket (`Upgrade`/`Connection` headers, `proxy_read_timeout` >= 1h) with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`. Do not log request bodies or the `Sec-WebSocket-Protocol` header (carries the session token) in nginx. Status: **deployed** at https://vanishgram.karatel.win via Cloudflare Tunnel (pm2 `tunnel`, ingress to localhost:8920; TLS is terminated by Cloudflare, so nginx/certbot are not used). pm2 app `vanishgram`, project-local Node 24 in `.node/`. Backup of tunnel config: `~/.cloudflared/config.yml.bak-vanishgram`.

### Database (MongoDB)

A dedicated `mongod` runs under pm2 as `vanishgram-mongo`: port 27018 on 127.0.0.1 only, authentication on, key file, single-node replica set `vg0` (needed for transactions). It shares nothing with other projects on the machine. Data in `mongo/db`, credentials in `mongo/*.pw` (mode 600). The app user can read and write only the `vanishgram` database; a separate test user can only touch the throwaway `vg_test_*` databases. Collections mirror the old tables; natural keys are `_id`; unique indexes arbitrate races (usernames, one owner per group, post numbers, one-time prekeys are taken atomically). Multi-document changes (account deletion, device registration, joining by invite) run in transactions.

Tests need a replica set: set `VG_TEST_MONGO_URI` (CI starts one with `supercharge/mongodb-github-action`). Each test file uses its own database, dropped on exit.

### Backups

Daily at 03:30 server time (user crontab), `backup.sh` runs `server/scripts/backup.ts`: a `mongodump` archive of the live database, verified with a `mongorestore --dryRun`, written atomically into `/home/tsar/projects/vanishgram/backups/` (dir 700, files 600), newest 14 kept. Log: `backups/backup.log`. The database holds only metadata and undelivered ciphertext, but it lists account IDs, usernames and who messaged whom, so treat backups as sensitive.

Restore: `pm2 stop vanishgram`, run `node server/scripts/restore.ts backups/<file>.archive.gz vanishgram <new-db-name>` (refuses a non-empty target), set `VG_MONGO_DB` to the new name in `ecosystem.config.cjs`, `pm2 start vanishgram`.

Migration from the earlier SQLite version: `server/scripts/migrate-sqlite.ts` (read-only on the SQLite side, refuses a non-empty target). The pre-migration SQLite files are kept in `data/pre-mongo/`.

Limits: backups sit on the same disk as the database, so they do not survive loss of the machine. No off-site copy is configured. A restore returns the server to the backup time: messages acknowledged since then are gone from the queue (clients keep their own history), and accounts deleted since then come back until the next inactivity purge or manual deletion.

## 10. Roadmap

1. **Phase 3 (in progress):** headless slice done. Done: persistent encrypted client storage, web client (apps/web: create/recover/unlock, chats, reply, delete for me/everyone, safety number, username, inactivity setting, light/dark). Missing: drafts sync, typing/read receipts, own-device sync, profile fields, privacy settings, block list, multiple accounts in one browser. UI note: delete for everyone is offered only on your own messages (a peer cannot delete your messages; differs from the spec wording, deliberate). (web), contact discovery UI, own-device sync, profile fields (display name, bio, avatar), privacy settings, block list.
2. **Phase 4:** attachments, groups (MLS), channels, calls, multiple accounts (isolated storage namespaces), TOTP + OPAQUE cloud password.
3. **Phase 5:** Redis for rate limits if several nodes are needed, load/chaos tests, external crypto review, backups/DR, monitoring without content.

Design system for the UI (planned): white `#FFFFFF`, blue `#2563EB` for actions, coral `#FF8A75` for accents; light default, dark optional.
