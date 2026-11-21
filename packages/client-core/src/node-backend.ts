// Node/Electron file backend. Browser builds use an IndexedDB backend instead (planned).
import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { VaultBackend } from './vault.ts';

export class FileBackend implements VaultBackend {
  path: string;
  constructor(path: string) { this.path = path; }
  async read() {
    try { return new Uint8Array(await readFile(this.path)); } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async write(bytes: Uint8Array) {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, this.path); // atomic replace
  }
  async remove() { await rm(this.path, { force: true }); }
}
