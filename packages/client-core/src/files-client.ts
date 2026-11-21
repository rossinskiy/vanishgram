// Encrypted attachments, client side. Files are split into 1 MiB chunks, each sealed with
// ChaCha20-Poly1305 under a random per-file key. The key never reaches the server: it travels inside the
// E2EE message envelope. Every chunk's AAD binds the file id, chunk index and chunk count, so chunks cannot be
// reordered, swapped between files, or silently truncated. A hash over all chunk hashes is carried in the envelope.
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { FILE_PLAIN_CHUNK, type FileInfo, type Envelope } from '@vanishgram/protocol';
import { b64, unb64, utf8, concat, u32, hex } from './encoding.ts';
import type { VanishClient, ChatMessage } from './client.ts';

const TAG = 16;
const LABEL = utf8('vanishgram/v1/file-chunk');

/** Anything we can read slices from: a browser File/Blob, or bytes in memory. */
export interface ByteSource { size: number; read(start: number, end: number): Promise<Uint8Array> }
export const fromBytes = (b: Uint8Array): ByteSource => ({ size: b.length, read: async (s, e) => b.slice(s, e) });
export const fromBlob = (b: Blob): ByteSource => ({ size: b.size, read: async (s, e) => new Uint8Array(await b.slice(s, e).arrayBuffer()) });

/** Where decrypted chunks go. A browser can stream them to disk; tests keep them in memory. */
export interface FileSink { write(chunk: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
export function memorySink(): FileSink & { bytes(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return { write: async (c) => { parts.push(c); }, close: async () => {}, abort: async () => { parts.length = 0; }, bytes: () => concat(...parts) };
}

export interface Progress { done: number; total: number }
export interface TransferOpts { onProgress?: (p: Progress) => void; signal?: AbortSignal }
export interface UploadMeta { name: string; mime: string; kind: FileInfo['kind']; thumb?: string; w?: number; h?: number; duration?: number; wave?: number[] }
/** Kept (encrypted, in the vault) so an interrupted upload can resume with the SAME key and identical ciphertext. */
export interface PendingUpload { id: string; key: string; meta: UploadMeta; size: number }

const nonce = (i: number) => concat(new Uint8Array(4), u32(Math.floor(i / 2 ** 32)), u32(i >>> 0));
const aad = (fileId: string, i: number, n: number) => concat(LABEL, utf8(fileId), u32(i), u32(n));
const sha = (b: Uint8Array) => sha256(b);

export const kindOfMime = (mime: string): FileInfo['kind'] => mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file';

export class AbortedError extends Error { constructor() { super('transfer aborted'); } }

export class FileManager {
  c: VanishClient;
  /** concurrency for chunk transfers */
  parallel = 3;
  constructor(c: VanishClient) { this.c = c; }

  private async putChunk(uploadId: string, n: number, data: Uint8Array, signal?: AbortSignal) {
    const digest = hex(sha(data));
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new AbortedError();
      try {
        const res = await fetch(`${this.c.baseUrl}/v1/uploads/${uploadId}/chunks/${n}`, {
          method: 'PUT', body: data as BodyInit, signal,
          headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${this.c.token}`, 'x-chunk-sha256': digest },
        });
        if (res.ok) return;
        if (res.status < 500 && res.status !== 429) throw Object.assign(new Error((await res.json().catch(() => ({}))).error ?? 'upload failed'), { status: res.status, fatal: true });
      } catch (e) { if ((e as any)?.fatal || signal?.aborted || attempt >= 4) throw (signal?.aborted ? new AbortedError() : e); }
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt)); // network hiccup or overload: back off and retry this chunk only
    }
  }

  /** Encrypt and upload. Pass `resume` to continue an interrupted upload of the same file. */
  async upload(source: ByteSource, meta: UploadMeta, opts: TransferOpts & { resume?: PendingUpload } = {}): Promise<FileInfo> {
    const c = this.c;
    if (source.size <= 0) throw new Error('the file is empty');
    if (source.size > 1024 ** 3) throw new Error('files are limited to 1 GB');
    const plainChunk = FILE_PLAIN_CHUNK, chunks = Math.ceil(source.size / plainChunk), cipherSize = source.size + chunks * TAG;
    let id: string, key: Uint8Array, received = new Set<number>();
    if (opts.resume) {
      id = opts.resume.id; key = unb64(opts.resume.key);
      if (opts.resume.size !== source.size) throw new Error('this is not the same file');
      received = new Set((await c.http<{ received: number[] }>('GET', `/v1/uploads/${id}`)).received);
    } else {
      key = randomBytes(32);
      id = (await c.http<{ id: string }>('POST', '/v1/uploads', { size: cipherSize, chunkSize: plainChunk + TAG })).id;
    }
    c.pendingUploads.set(id, { id, key: b64(key), meta, size: source.size }); void c.flush().catch(() => {});

    const hashes: Uint8Array[] = [];
    let done = received.size * plainChunk;
    const inflight = new Set<Promise<void>>();
    let failure: unknown = null;
    for (let i = 0; i < chunks; i++) {
      if (opts.signal?.aborted) throw new AbortedError();
      if (failure) break;
      const plain = await source.read(i * plainChunk, Math.min((i + 1) * plainChunk, source.size));
      const sealed = chacha20poly1305(key, nonce(i), aad(id, i, chunks)).encrypt(plain);
      hashes.push(sha(sealed));
      if (received.has(i)) continue; // already on the server from an earlier attempt (identical ciphertext)
      const p = this.putChunk(id, i, sealed, opts.signal).then(() => { done += plain.length; opts.onProgress?.({ done: Math.min(done, source.size), total: source.size }); }, (e) => { failure ??= e; });
      inflight.add(p); void p.finally(() => inflight.delete(p));
      if (inflight.size >= this.parallel) await Promise.race(inflight);
    }
    await Promise.all(inflight);
    if (failure) throw failure;
    await c.http('POST', `/v1/uploads/${id}/complete`);
    c.pendingUploads.delete(id); void c.flush().catch(() => {});
    opts.onProgress?.({ done: source.size, total: source.size });
    return { fileId: id, ...meta, size: source.size, key: b64(key), chunkSize: plainChunk, chunks, hash: b64(sha(concat(...hashes))) };
  }

  /** Let more accounts (or a whole group) download this file. */
  attach(fileId: string, to: { accounts?: string[]; group?: string }) { return this.c.http('POST', `/v1/files/${fileId}/attach`, to); }

  /** Download, verify and decrypt chunk by chunk into `sink`. Throws (and aborts the sink) on any tampering. */
  async download(info: FileInfo, sink: FileSink, opts: TransferOpts = {}): Promise<void> {
    const c = this.c, key = unb64(info.key);
    const hashes: Uint8Array[] = [];
    let done = 0;
    try {
      for (let i = 0; i < info.chunks; i++) {
        if (opts.signal?.aborted) throw new AbortedError();
        let res: Response | null = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          try { res = await fetch(`${c.baseUrl}/v1/files/${info.fileId}/chunks/${i}`, { headers: { authorization: `Bearer ${c.token}` }, signal: opts.signal }); if (res.ok || res.status < 500) break; }
          catch (e) { if (opts.signal?.aborted) throw new AbortedError(); if (attempt === 3) throw e; }
          await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        }
        if (!res?.ok) throw Object.assign(new Error(res?.status === 404 ? 'this file is no longer available' : 'download failed'), { status: res?.status });
        const sealed = new Uint8Array(await res.arrayBuffer());
        hashes.push(sha(sealed));
        let plain: Uint8Array;
        try { plain = chacha20poly1305(key, nonce(i), aad(info.fileId, i, info.chunks)).decrypt(sealed); }
        catch { throw new Error('the file is corrupted or has been tampered with'); }
        await sink.write(plain);
        done += plain.length; opts.onProgress?.({ done, total: info.size });
      }
      if (b64(sha(concat(...hashes))) !== info.hash || done !== info.size) throw new Error('the file is corrupted or incomplete');
      await sink.close();
    } catch (e) { await sink.abort().catch(() => {}); throw e; }
  }

  /** I no longer need my copy on the server (deleted for me or saved elsewhere). */
  release(fileId: string) { return this.c.http('POST', `/v1/files/${fileId}/release`).catch(() => {}); }
  /** Delete for everyone: only the uploader can. */
  removeForEveryone(fileId: string) { return this.c.http('DELETE', `/v1/files/${fileId}`).catch(() => {}); }

  /** Upload, share and post a file message into a chat (`peerAccountId` or `g:<groupId>`). */
  async send(chat: string, source: ByteSource, meta: UploadMeta, opts: TransferOpts & { caption?: string; replyTo?: string; resume?: PendingUpload } = {}): Promise<ChatMessage> {
    const c = this.c;
    const info = await this.upload(source, meta, opts);
    return this.post(chat, info, opts.caption, opts.replyTo);
  }

  async post(chat: string, info: FileInfo, caption?: string, replyTo?: string, fwd?: string): Promise<ChatMessage> {
    const c = this.c, id = hex(crypto.getRandomValues(new Uint8Array(12)));
    const env: Envelope = { t: 'file', id, file: info, ts: Date.now(), ...(caption ? { body: caption } : {}), ...(replyTo ? { replyTo } : {}), ...(fwd ? { fwd } : {}) };
    let serverIds: string[];
    if (chat.startsWith('g:')) { await this.attach(info.fileId, { group: chat.slice(2) }); serverIds = await c.gm.sendEnvelope(chat.slice(2), env); }
    else { await this.attach(info.fileId, { accounts: [chat] }); serverIds = await c.deliver(chat, env); }
    return c.store(chat, { id, from: c.account.accountId, body: caption ?? '', ts: env.ts, replyTo, serverIds, file: info, ...(fwd ? { fwd } : {}) });
  }
}
