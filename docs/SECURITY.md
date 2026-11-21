# Security

Vanishgram is early software. Pairwise encryption uses the official libsignal (PQXDH and Double Ratchet), Group chats use MLS through the `ts-mls` library, which states that it has not been audited. Our integration of both, and everything around them, has **not been independently audited**. Do not rely on it where your safety depends on it.

## Reporting a vulnerability

Please report privately and do not open a public issue. Send the details (what, how to reproduce, impact) to the operator through the contact listed on the website. We acknowledge reports within a few days and will say what we plan to do. Good-faith research on your own account is welcome; please do not access other people's data, run denial-of-service tests against the live service, or test social engineering.

## What is and is not protected

See `docs/ARCHITECTURE.md`, sections "What the server can see" and "Threat model". In short: message text, attachments and call audio are end-to-end encrypted. The server sees metadata (who talks to whom and when, sizes, usernames, group rosters, device list) and the plaintext of public channels, profile fields and abuse reports a user chose to send.

## Moderation without reading messages

Abuse handling works from metadata only: sending rates, how many different people reported an account, and reports. A report can carry plaintext evidence only if the reporter attached it and ticked a consent box. Operators use `server/scripts/moderate.ts` over SSH. There is no administrative way to read messages and none is planned.

## Dependency and code scanning

CI runs type checks, the full test suite, `npm audit --omit=dev` (fails on high severity) and CodeQL on every push; Dependabot proposes weekly updates. Status when this file was written: 0 known vulnerabilities in production dependencies.

## Desktop app

Installers are currently unsigned. Verify the SHA-256 shown on the website before running one. The app loads its interface from inside the installer; the server cannot replace it. Report problems privately, as above.

## Known dependency advisories

`@signalapp/libsignal-client` pulls in `@signalapp/types`, which pins `zod` 4.3.6 and `uuid` 13.0.0 exactly. `npm audit` flags both (a memory-exhaustion issue in zod collection validation and a buffer bounds check in uuid v3/v5/v6). We cannot override those pins, we never run untrusted data through those validators or call those functions, and the server does not load the package. The CI gate (`scripts/audit-gate.mjs`) accepts exactly these two advisories and fails on anything else.
