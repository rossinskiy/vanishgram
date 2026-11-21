import { build } from 'esbuild';
import { mkdir, writeFile, cp } from 'node:fs/promises';
await mkdir('dist-e2e', { recursive: true });
await build({ entryPoints: ['e2e/call-loopback.ts'], outfile: 'dist-e2e/call-test.js', bundle: true, format: 'iife', target: 'es2022', logLevel: 'error' });
await writeFile('dist-e2e/call-test.html', '<!doctype html><meta charset="utf-8"><title>call e2e</title><pre id="out"></pre><script src="/call-test.js"></script>');
console.log('e2e built');
