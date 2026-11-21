// Copies the built web interface into the app and locks it down with a Content-Security-Policy, as the desktop app does.
import { cp, rm, readFile, writeFile } from 'node:fs/promises';
await rm('www', { recursive: true, force: true });
await cp('../web/dist', 'www', { recursive: true });
const API = 'vanishgram.karatel.win';
const csp = ["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:", "font-src 'self'",
  `connect-src 'self' https://${API} wss://${API} https://stun.cloudflare.com https://rtc.live.cloudflare.com`, "base-uri 'none'", "form-action 'none'"].join('; ');
let html = await readFile('www/index.html', 'utf8');
html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`);
await writeFile('www/index.html', html);
console.log('mobile www ready');
