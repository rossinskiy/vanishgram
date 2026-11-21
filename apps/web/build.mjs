import { build } from 'esbuild';
import { cp, rm, mkdir } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/main.ts'], outfile: 'dist/app.js', bundle: true, format: 'iife', target: 'es2022',
  minify: true, sourcemap: false, legalComments: 'none', define: { 'process.env.NODE_ENV': '"production"' },
});
await cp('public', 'dist', { recursive: true });
await cp('index.html', 'dist/index.html');
console.log('web built -> apps/web/dist');
