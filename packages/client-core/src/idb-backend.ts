// Browser backend: one IndexedDB record per account vault. The record is already encrypted.
import type { VaultBackend } from './vault.ts';

const DB = 'vanishgram', STORE = 'vaults';
const open = (): Promise<IDBDatabase> => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await open();
  return new Promise<T>((res, rej) => {
    const t = db.transaction(STORE, mode); const rq = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); res(rq.result); };
    t.onerror = t.onabort = () => { db.close(); rej(t.error); };
  });
};

export class IdbBackend implements VaultBackend {
  key: string;
  constructor(key: string) { this.key = key; }
  async read() { const v = await tx<ArrayBuffer | Uint8Array | undefined>('readonly', (s) => s.get(this.key)); return v ? new Uint8Array(v as ArrayBuffer) : null; }
  async write(bytes: Uint8Array) { await tx('readwrite', (s) => s.put(bytes, this.key)); } // single-record put is atomic
  async remove() { await tx('readwrite', (s) => s.delete(this.key)); }
  /** Vault keys present in this browser (account ids), for the account picker. */
  static async list(): Promise<string[]> { return (await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys())).map(String); }
}
