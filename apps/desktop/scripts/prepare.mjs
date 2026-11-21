// Copy the built web interface into the app folder so it ships inside the installer.
import { cp, rm, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
await rm('app', { recursive: true, force: true });
await mkdir('app', { recursive: true });
await cp('../web/dist', 'app', { recursive: true });
// the 404 page and legal pages are for the website; the app only needs the interface
await rm('app/404.html', { force: true });
// The crypto engine (libsignal wrapper) is bundled for the main process; the native library itself stays a normal dependency.
await build({
  entryPoints: ['../../packages/signal-engine/src/index.ts'], outfile: 'signal-engine.mjs', bundle: true, format: 'esm', platform: 'node', target: 'node22',
  external: ['@signalapp/libsignal-client'], legalComments: 'none',
});
console.log('desktop app folder prepared');
