// Prepares a release for the update server. Run on the maintainer's computer, where the signing key lives.
//   node scripts/release.mjs <folder-with-ci-artifacts> <output-folder>
// Collects the installers, blockmaps and electron-builder's latest*.yml files, and writes release.json: the version and the
// sha512 of every file, signed with the private key. The app refuses any update that is not covered by that signature.
import { readdir, readFile, writeFile, copyFile, mkdir, stat } from 'node:fs/promises';
import { createPrivateKey, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);
const { canonical, verifyRelease } = require('../apps/desktop/release-verify.cjs');
const { UPDATE_PUBLIC_KEY } = require('../apps/desktop/update-key.cjs');

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node scripts/release.mjs <artifacts-folder> <output-folder>'); process.exit(2); }
const keyPath = process.env.VG_RELEASE_KEY ?? join(homedir(), '.claude', 'vanishgram-release', 'release-private.pem');

async function walk(d) { const o = []; for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) o.push(...await walk(p)); else o.push(p); } return o; }
const all = await walk(src);
await mkdir(out, { recursive: true });
let version = null; const files = [];
for (const p of all) {
  const n = basename(p);
  if (!/^(latest(-linux|-mac)?\.yml|Vanishgram-[A-Za-z0-9._-]+\.(exe|AppImage|dmg|blockmap))$/.test(n)) continue;
  await copyFile(p, join(out, n));
  if (/^latest(-linux)?\.yml$/.test(n)) { // the files the app may download, with the hashes electron-builder computed
    const y = await readFile(p, 'utf8');
    const v = /^version:\s*(\S+)/m.exec(y)?.[1]; if (!v) throw new Error(`no version in ${n}`);
    if (version && version !== v) throw new Error(`mixed versions: ${version} and ${v}`);
    version = v;
    for (const m of y.matchAll(/-\s*url:\s*(\S+)\s*\n\s*sha512:\s*(\S+)/g)) files.push({ name: basename(m[1]), sha512: m[2] });
  }
}
if (!version || !files.length) throw new Error('no latest.yml with files found: was the build made with the publish setting?');
const release = { version, files };
release.sig = sign(null, Buffer.from(canonical(release)), createPrivateKey(await readFile(keyPath))).toString('base64');
if (!verifyRelease(release, UPDATE_PUBLIC_KEY)) throw new Error('the signature does not verify with the key built into the app: wrong signing key');
await writeFile(join(out, 'release.json'), JSON.stringify(release, null, 2));
for (const f of files) await stat(join(out, f.name)); // every signed file is really there
console.log(`release ${version}: ${files.length} signed file(s) in ${out}`);
