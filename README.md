# Vanishgram

A privacy-first desktop messenger: anonymous accounts (12 words, no phone or email), end-to-end encrypted chats, groups, channels and calls.

* Website and downloads: https://vanishgram.karatel.win
* Pairwise chats: the official libsignal (PQXDH and Double Ratchet). Groups: MLS (RFC 9420) through ts-mls. Cloud password: OPAQUE.
* Early software, **not independently audited**. Read [docs/SECURITY.md](docs/SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first.

## Layout

| Path | What | Licence |
| --- | --- | --- |
| `packages/protocol` | wire types and limits | GPL-3.0-or-later |
| `packages/client-core` | account, vault, chats, groups (MLS), calls, files | GPL-3.0-or-later |
| `packages/signal-engine` | libsignal wrapper | AGPL-3.0-only |
| `apps/web` | the interface (bundled into the desktop app) | GPL-3.0-or-later |
| `apps/desktop` | Electron shell, installers | AGPL-3.0-only |
| `apps/landing` | the website | GPL-3.0-or-later |

The desktop app combines these with libsignal, so the distributed app as a whole is AGPL-3.0. The relay server is a separate closed program; it only ever sees ciphertext and metadata, and the API it speaks is described in the architecture document.

## Build

```bash
npm install
npm test
npm run typecheck
npm run dist:win -w @vanishgram/desktop     # or dist:linux / dist:mac on that OS
```

Report security problems privately (see docs/SECURITY.md).
