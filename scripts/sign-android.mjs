// Signs the Android build from CI on the maintainer's computer, where the key lives (never in CI).
//   node scripts/sign-android.mjs <folder-with-ci-artifacts> <output-folder>
// Produces Vanishgram-<version>.aab (for Google Play, upload key) and Vanishgram-<version>.apk (direct download).
import { readdir, mkdir, copyFile, access, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node scripts/sign-android.mjs <artifacts-folder> <output-folder>'); process.exit(2); }
const dir = process.env.VG_RELEASE_DIR ?? join(homedir(), '.claude', 'vanishgram-release');
const ks = join(dir, 'android-upload.jks'), alias = 'vanishgram';
const password = readFileSync(join(dir, 'android-keystore.pw'), 'utf8').trim();
const version = JSON.parse(readFileSync(new URL('../apps/mobile/package.json', import.meta.url), 'utf8')).version;

async function walk(d) { const o = []; for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) o.push(...await walk(p)); else o.push(p); } return o; }
const files = await walk(src);
const aab = files.find((f) => basename(f) === 'app-release.aab'), apk = files.find((f) => basename(f) === 'app-release-unsigned.apk');
if (!aab || !apk) throw new Error('app-release.aab or app-release-unsigned.apk not found in the artifacts');
await mkdir(out, { recursive: true });

// 1. the bundle for Google Play: a plain jar signature with the upload key
const outAab = join(out, `Vanishgram-${version}.aab`);
await copyFile(aab, outAab);
execFileSync('jarsigner', ['-sigalg', 'SHA256withRSA', '-digestalg', 'SHA-256', '-keystore', ks, '-storepass', password, outAab, alias], { stdio: 'inherit' });

// 2. the APK: v2/v3 signature through Google's apksig library, fetched once from Maven Central
const tools = join(dir, 'tools'); await mkdir(tools, { recursive: true });
const jar = join(tools, 'apksig-8.13.0.jar');
try { await access(jar); } catch {
  const r = await fetch('https://repo1.maven.org/maven2/com/android/tools/build/apksig/8.13.0/apksig-8.13.0.jar');
  if (!r.ok) throw new Error('could not download apksig'); await writeFile(jar, Buffer.from(await r.arrayBuffer()));
}
const outApk = join(out, `Vanishgram-${version}.apk`);
execFileSync('java', ['-cp', jar, new URL('./android/ApkSign.java', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), ks, alias, apk, outApk], { stdio: 'inherit', env: { ...process.env, VG_KEYSTORE_PASSWORD: password } });
console.log(`signed: ${outAab}\nsigned: ${outApk}`);
