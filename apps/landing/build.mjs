// Builds the website (dist/) and the folder of installers to publish (dist-downloads/).
//   node build.mjs [installers-dir ...]      installers are matched by file name; sizes and SHA-256 come from the real files
import { readFile, writeFile, mkdir, rm, cp, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['../desktop/dist'];
await rm('dist', { recursive: true, force: true }); await rm('dist-downloads', { recursive: true, force: true });
await mkdir('dist', { recursive: true }); await mkdir('dist-downloads', { recursive: true });

// shared pages (legal, 404, favicon, design tokens used by those pages) come from the app's public folder
await cp('../web/public', 'dist', { recursive: true });
await cp('src/landing.css', 'dist/landing.css'); await cp('src/landing.js', 'dist/landing.js');

const PLATFORMS = [
  { os: 'win', title: 'Windows', re: /^Vanishgram-([\d.]+)-win-x64\.exe$/, note: 'Windows 10 or later, 64-bit' },
  { os: 'mac', title: 'macOS', re: /^Vanishgram-([\d.]+)-mac-(arm64|x64)\.dmg$/, note: 'macOS 12 or later', multi: true },
  { os: 'linux', title: 'Linux', re: /^Vanishgram-([\d.]+)-linux-x86_64\.AppImage$/, note: 'Any recent 64-bit distribution (AppImage)' },
];
const found = [];
for (const d of dirs) for (const f of await readdir(d).catch(() => [])) {
  for (const p of PLATFORMS) { const m = p.re.exec(f); if (m) found.push({ ...p, version: m[1], arch: m[2], name: f, path: join(d, f) }); }
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;

const cards = []; const manifest = []; let version = '';
const sha256Of = async (f) => { const buf = await readFile(f.path); await writeFile(join('dist-downloads', f.name), buf); return { sha: createHash('sha256').update(buf).digest('hex'), size: (await stat(f.path)).size }; };
for (const p of PLATFORMS.filter((x) => x.multi)) {
  // one card, one download per processor type
  const latest = (arch) => found.filter((x) => x.os === p.os && x.arch === arch).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  const parts = [];
  for (const [arch, label] of [['arm64', 'Apple Silicon (M1 or newer)'], ['x64', 'Intel']]) {
    const f = latest(arch);
    if (!f) { parts.push(`<span class="fine">${label}: not available yet</span>`); continue; }
    const { sha, size } = await sha256Of(f);
    manifest.push({ os: p.os, arch, name: f.name, version: f.version, size, sha256: sha }); version = f.version;
    parts.push(`<a class="btn" href="/download/${esc(f.name)}" download>Download for ${label}</a><span class="fine">${mb(size)} &middot; SHA-256</span><code>${sha}</code><button class="btn ghost copy" type="button" data-copy="${sha}">Copy checksum</button>`);
  }
  p.card = `<div class="dl" data-os="${p.os}"><h3>${p.title}</h3><p class="meta">${esc(p.note)} &middot; version ${esc(version)}</p>${parts.join('')}</div>`;
}
for (const p of PLATFORMS) {
  if (p.multi) { cards.push(p.card); continue; }
  const f = found.filter((x) => x.os === p.os).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  if (!f) { cards.push(`<div class="dl" data-os="${p.os}"><h3>${p.title}</h3><p class="meta">${esc(p.note)}</p><a class="btn ghost" href="#download" aria-disabled="true">Not available yet</a><p class="fine">This build has not been published yet.</p></div>`); continue; }
  const buf = await readFile(f.path), sha = createHash('sha256').update(buf).digest('hex'), size = (await stat(f.path)).size;
  await writeFile(join('dist-downloads', f.name), buf);
  manifest.push({ os: p.os, name: f.name, version: f.version, size, sha256: sha }); version = f.version;
  cards.push(`<div class="dl" data-os="${p.os}"><h3>${p.title}</h3><p class="meta">${esc(p.note)} &middot; version ${esc(f.version)} &middot; ${mb(size)}</p>`
    + `<a class="btn" href="/download/${esc(f.name)}" download>Download for ${p.title}</a>`
    + `<span class="fine">SHA-256</span><code>${sha}</code><button class="btn ghost copy" type="button" data-copy="${sha}">Copy checksum</button></div>`);
}
await writeFile('dist-downloads/Vanishgram-manifest.json', JSON.stringify({ files: manifest }, null, 2));

const hero = '<a class="btn" href="#download">Download</a>';
const now = new Date();
let html = await readFile('src/index.template.html', 'utf8');
html = html.replace('{{DOWNLOAD_CARDS}}', cards.join('\n          ')).replace('{{HERO_BUTTON}}', hero).replace('{{VERSION}}', esc(version || 'in preparation'))
  .replace('{{YEAR}}', String(now.getFullYear())).replace('{{UPDATED}}', now.toISOString().slice(0, 10));
await writeFile('dist/index.html', html);
console.log(`landing built: ${manifest.length} installer(s) listed`);
