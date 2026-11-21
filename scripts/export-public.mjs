// Builds the public source tree (everything except the proprietary server) in a new folder.
//   node scripts/export-public.mjs <output-dir>
// The server is a separate, closed program that talks to the client over the documented API; only the client must be published.
import { cp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const out = resolve(process.argv[2] ?? '');
if (!process.argv[2]) { console.error('usage: node scripts/export-public.mjs <output-dir>'); process.exit(2); }
await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
const SKIP = new Set(['node_modules', 'dist', 'dist-downloads', '.git', 'server', 'tsconfig.tsbuildinfo', 'signal-engine.mjs', '.backup']);
await cp('.', out, { recursive: true, filter: (src) => {
  const rel = src.replace(/\\/g, '/').split('/').slice(-1)[0];
  if (SKIP.has(rel)) return false;
  if (/apps\/desktop\/app$/.test(src.replace(/\\/g, '/'))) return false;
  return !/\.(db|db-wal|db-shm|pw|token)$/.test(rel);
} });

const pkg = JSON.parse(await readFile(`${out}/package.json`, 'utf8'));
pkg.workspaces = ['packages/*', 'apps/*'];
pkg.scripts.test = 'npm run test -w @vanishgram/signal-engine && npm run test -w @vanishgram/client-core';
await writeFile(`${out}/package.json`, JSON.stringify(pkg, null, 2) + '\n');

const ts = JSON.parse(await readFile(`${out}/tsconfig.json`, 'utf8'));
ts.include = ts.include.filter((p) => !p.startsWith('server'));
await writeFile(`${out}/tsconfig.json`, JSON.stringify(ts, null, 2) + '\n');

await writeFile(`${out}/.github/workflows/ci.yml`, `name: ci
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build:web
      - name: Known vulnerabilities in production dependencies
        run: npm audit --omit=dev --json | node scripts/audit-gate.mjs
`);
await rm(`${out}/package-lock.json`, { force: true });
execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: out, stdio: 'inherit', shell: true });

await writeFile(`${out}/README.md`, `# Vanishgram

A privacy-first desktop messenger: anonymous accounts (12 words, no phone or email), end-to-end encrypted chats, groups, channels and calls.

* Website and downloads: https://vanishgram.karatel.win
* Pairwise chats: the official libsignal (PQXDH and Double Ratchet). Groups: MLS (RFC 9420) through ts-mls. Cloud password: OPAQUE.
* Early software, **not independently audited**. Read [docs/SECURITY.md](docs/SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first.

## Layout

| Path | What | Licence |
| --- | --- | --- |
| \`packages/protocol\` | wire types and limits | GPL-3.0-or-later |
| \`packages/client-core\` | account, vault, chats, groups (MLS), calls, files | GPL-3.0-or-later |
| \`packages/signal-engine\` | libsignal wrapper | AGPL-3.0-only |
| \`apps/web\` | the interface (bundled into the desktop app) | GPL-3.0-or-later |
| \`apps/desktop\` | Electron shell, installers | AGPL-3.0-only |
| \`apps/landing\` | the website | GPL-3.0-or-later |

The desktop app combines these with libsignal, so the distributed app as a whole is AGPL-3.0. The relay server is a separate closed program; it only ever sees ciphertext and metadata, and the API it speaks is described in the architecture document.

## Build

\`\`\`bash
npm install
npm test
npm run typecheck
npm run dist:win -w @vanishgram/desktop     # or dist:linux / dist:mac on that OS
\`\`\`

Report security problems privately (see docs/SECURITY.md).
`);
console.log('public tree written to', out);
