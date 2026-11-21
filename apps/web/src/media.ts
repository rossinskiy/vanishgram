// Attachments in the browser: thumbnails, uploading with progress, inline previews, downloading,
// and voice recording. Everything is decrypted on the device; the server only ever sees ciphertext chunks.
import { fromBlob, memorySink, kindOfMime, AbortedError, type VanishClient, type ChatMessage, type FileSink } from '@vanishgram/client-core';
import type { FileInfo } from '@vanishgram/protocol';
import { b64 } from '@vanishgram/client-core';
import { h, icon, toast } from './dom.ts';

export const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
export const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const AUTO_IMAGE_BYTES = 8 * 1024 * 1024;

// ---------- thumbnails (tiny, travel inside the encrypted message) ----------
export interface Thumb { thumb?: string; w?: number; h?: number; duration?: number }

async function drawThumb(src: CanvasImageSource, w: number, h0: number): Promise<string | undefined> {
  const scale = 48 / Math.max(w, h0);
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h0 * scale));
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  c.getContext('2d')!.drawImage(src, 0, 0, cw, ch);
  const blob: Blob | null = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.5));
  if (!blob || blob.size > 6000) return undefined;
  return b64(new Uint8Array(await blob.arrayBuffer()));
}

export async function thumbFor(file: File): Promise<Thumb> {
  try {
    if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') {
      const bmp = await createImageBitmap(file);
      return { thumb: await drawThumb(bmp, bmp.width, bmp.height), w: bmp.width, h: bmp.height };
    }
    if (file.type.startsWith('video/')) {
      const url = URL.createObjectURL(file);
      try {
        const v = document.createElement('video'); v.muted = true; v.preload = 'metadata'; v.src = url;
        await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error('video')); setTimeout(() => rej(new Error('timeout')), 6000); });
        return { thumb: await drawThumb(v, v.videoWidth, v.videoHeight), w: v.videoWidth, h: v.videoHeight, duration: Math.round(v.duration || 0) };
      } finally { URL.revokeObjectURL(url); }
    }
  } catch { /* no preview: the file still sends */ }
  return {};
}

// ---------- uploads (shown as pending bubbles until they finish) ----------
export interface Upload { id: string; chat: string; name: string; size: number; done: number; abort: AbortController; failed: boolean; kind: FileInfo['kind'] }
export const uploads = new Map<string, Upload>();
let notify: () => void = () => {};
export const onUploadsChange = (fn: () => void) => { notify = fn; };

export async function sendFiles(client: VanishClient, chat: string, files: File[], opts: { caption?: string; replyTo?: string; voice?: { duration: number; wave: number[] } } = {}) {
  for (const [i, file] of files.entries()) {
    if (file.size === 0) { toast(`${file.name} is empty.`); continue; }
    if (file.size > 1024 ** 3) { toast(`${file.name} is larger than 1 GB.`); continue; }
    const up: Upload = { id: crypto.randomUUID(), chat, name: file.name, size: file.size, done: 0, abort: new AbortController(), failed: false, kind: opts.voice ? 'voice' : kindOfMime(file.type) };
    uploads.set(up.id, up); notify();
    try {
      const t = opts.voice ? { duration: opts.voice.duration, wave: opts.voice.wave } : await thumbFor(file);
      await client.files.send(chat, fromBlob(file), { name: file.name, mime: file.type || 'application/octet-stream', kind: up.kind, ...t },
        { signal: up.abort.signal, caption: i === 0 ? opts.caption : undefined, replyTo: i === 0 ? opts.replyTo : undefined, onProgress: (p) => { up.done = p.done; notify(); } });
      uploads.delete(up.id);
    } catch (e) {
      if (e instanceof AbortedError) uploads.delete(up.id);
      else { up.failed = true; toast(`Could not send ${file.name}. ${(e as Error).message}`); }
    }
    notify();
  }
}

// ---------- downloads ----------
const blobCache = new Map<string, Promise<string>>();
function cachedBlobUrl(client: VanishClient, info: FileInfo, onProgress: (p: number) => void): Promise<string> {
  let p = blobCache.get(info.fileId);
  if (!p) {
    const sink = memorySink();
    p = client.files.download(info, sink, { onProgress: (x) => onProgress(x.done / x.total) })
      .then(() => URL.createObjectURL(new Blob([sink.bytes() as BlobPart], { type: info.mime })))
      .catch((e) => { blobCache.delete(info.fileId); throw e; });
    blobCache.set(info.fileId, p);
  }
  return p;
}

/** Stream straight to disk where the browser allows it (big files), otherwise assemble in memory. */
export async function saveToDisk(client: VanishClient, info: FileInfo, onProgress: (p: number) => void) {
  const picker = (window as any).showSaveFilePicker as undefined | ((o: any) => Promise<any>);
  if (picker && info.size > 32 * 1024 * 1024) {
    const handle = await picker({ suggestedName: info.name });
    const w = await handle.createWritable();
    const sink: FileSink = { write: (c) => w.write(c), close: () => w.close(), abort: () => w.abort() };
    await client.files.download(info, sink, { onProgress: (x) => onProgress(x.done / x.total) });
    return;
  }
  const url = await cachedBlobUrl(client, info, onProgress);
  const a = h('a', { href: url, download: info.name }); document.body.append(a); a.click(); a.remove();
}

const ring = (p: number) => { const el = h('span', { class: 'ring', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(p * 100)) }); el.style.setProperty('--p', `${Math.round(p * 100)}%`); return el; };

// ---------- how a file looks inside a message ----------
export function attachmentNode(client: VanishClient, m: ChatMessage, rerender: () => void): Node {
  const f = m.file!;
  if (f.kind === 'image') return imageNode(client, f);
  if (f.kind === 'video') return videoNode(client, f);
  if (f.kind === 'voice' || f.kind === 'audio') return audioNode(client, f);
  return fileNode(client, f, rerender);
}

function ratioBox(f: FileInfo, cls: string): HTMLElement {
  const box = h('div', { class: cls });
  const w = f.w ?? 4, hh = f.h ?? 3;
  box.style.setProperty('--ar', String(Math.max(0.5, Math.min(2, w / hh))));
  if (f.thumb) box.style.setProperty('--thumb', `url("data:image/jpeg;base64,${f.thumb}")`);
  return box;
}

function imageNode(client: VanishClient, f: FileInfo): Node {
  const box = ratioBox(f, 'media media-image'), prog = h('div', { class: 'media-overlay' });
  box.append(prog);
  const load = async () => {
    prog.replaceChildren(ring(0.02));
    try {
      const url = await cachedBlobUrl(client, f, (p) => prog.replaceChildren(ring(p)));
      const img = h('img', { src: url, alt: f.name, class: 'media-img' });
      img.addEventListener('click', () => lightbox(url, f.name));
      box.replaceChildren(img); box.classList.add('loaded');
    } catch (e) { prog.replaceChildren(h('button', { class: 'media-btn', type: 'button', onClick: () => void load(), 'aria-label': 'Retry download' }, icon('download'))); toast((e as Error).message); }
  };
  if (f.size <= AUTO_IMAGE_BYTES) void load();
  else prog.replaceChildren(h('button', { class: 'media-btn', type: 'button', 'aria-label': `Download image, ${fmtSize(f.size)}`, onClick: () => void load() }, icon('download'), h('span', {}, fmtSize(f.size))));
  return box;
}

function videoNode(client: VanishClient, f: FileInfo): Node {
  const box = ratioBox(f, 'media media-video'), overlay = h('div', { class: 'media-overlay' });
  box.append(overlay); if (f.duration) box.append(h('span', { class: 'media-chip' }, fmtDur(f.duration)));
  const play = async () => {
    overlay.replaceChildren(ring(0.02));
    try {
      const url = await cachedBlobUrl(client, f, (p) => overlay.replaceChildren(ring(p)));
      const v = h('video', { src: url, controls: true, playsinline: true, class: 'media-img', preload: 'metadata' });
      box.replaceChildren(v); box.classList.add('loaded'); void v.play().catch(() => {});
    } catch (e) { overlay.replaceChildren(h('button', { class: 'media-btn', type: 'button', onClick: () => void play(), 'aria-label': 'Retry' }, icon('download'))); toast((e as Error).message); }
  };
  overlay.append(h('button', { class: 'media-btn big', type: 'button', 'aria-label': `Play video, ${fmtSize(f.size)}`, onClick: () => void play() }, icon('play')));
  return box;
}

function audioNode(client: VanishClient, f: FileInfo): Node {
  const voice = f.kind === 'voice';
  const btn = h('button', { class: 'audio-btn', type: 'button', 'aria-label': 'Play' }, icon('play'));
  const canvas = h('canvas', { class: 'wave', width: '160', height: '28', 'aria-hidden': 'true' });
  const time = h('span', { class: 'audio-time muted small' }, fmtDur(f.duration ?? 0));
  const wave = f.wave && f.wave.length ? f.wave : Array.from({ length: 40 }, (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i * 0.7)));
  const draw = (progress: number) => {
    const g = canvas.getContext('2d')!, w = canvas.width, hh = canvas.height, n = wave.length, bar = w / n;
    g.clearRect(0, 0, w, hh);
    const css = getComputedStyle(canvas);
    for (let i = 0; i < n; i++) {
      g.fillStyle = (i / n <= progress ? css.getPropertyValue('--wave-on') : css.getPropertyValue('--wave-off')).trim() || '#2563eb';
      const bh = Math.max(3, wave[i]! * hh); g.beginPath(); g.roundRect(i * bar + 1, (hh - bh) / 2, Math.max(2, bar - 2), bh, 2); g.fill();
    }
  };
  let audio: HTMLAudioElement | null = null;
  const ensure = async () => {
    if (audio) return audio;
    btn.replaceChildren(ring(0.02));
    const url = await cachedBlobUrl(client, f, (p) => btn.replaceChildren(ring(p)));
    audio = h('audio', { src: url, preload: 'auto' });
    audio.addEventListener('timeupdate', () => { draw(audio!.currentTime / (audio!.duration || f.duration || 1)); time.textContent = fmtDur(audio!.currentTime); });
    audio.addEventListener('ended', () => { btn.replaceChildren(icon('play')); draw(0); time.textContent = fmtDur(f.duration ?? 0); });
    audio.addEventListener('pause', () => { btn.replaceChildren(icon('play')); btn.setAttribute('aria-label', 'Play'); });
    audio.addEventListener('play', () => { btn.replaceChildren(icon('pause')); btn.setAttribute('aria-label', 'Pause'); });
    return audio;
  };
  btn.addEventListener('click', async () => { try { const a = await ensure(); if (a.paused) await a.play(); else a.pause(); } catch (e) { btn.replaceChildren(icon('play')); toast((e as Error).message); } });
  canvas.addEventListener('click', async (e) => { try { const a = await ensure(); const r = canvas.getBoundingClientRect(); a.currentTime = ((e.clientX - r.left) / r.width) * (a.duration || f.duration || 0); } catch { /* ignore */ } });
  setTimeout(() => draw(0), 0);
  return h('div', { class: `audio ${voice ? 'voice' : ''}` }, btn, h('div', { class: 'audio-body' }, voice ? canvas : h('div', { class: 'name small' }, f.name), voice ? null : canvas, time));
}

function fileNode(client: VanishClient, f: FileInfo, _rerender: () => void): Node {
  const state = h('div', { class: 'file-state' }, icon('download'));
  const btn = h('button', { class: 'file-card', type: 'button', 'aria-label': `Download ${f.name}, ${fmtSize(f.size)}` },
    h('span', { class: 'file-icon' }, icon('file')), h('span', { class: 'file-meta' }, h('span', { class: 'name small' }, f.name), h('span', { class: 'muted small' }, fmtSize(f.size))), state);
  let busy = false;
  btn.addEventListener('click', async () => {
    if (busy) return; busy = true;
    state.replaceChildren(ring(0.02));
    try { await saveToDisk(client, f, (p) => state.replaceChildren(ring(p))); state.replaceChildren(icon('check')); }
    catch (e) { state.replaceChildren(icon('download')); if ((e as Error).name !== 'AbortError') toast((e as Error).message); }
    busy = false;
  });
  return btn;
}

function lightbox(url: string, name: string) {
  const prev = document.activeElement as HTMLElement | null;
  const close = () => { o.remove(); document.removeEventListener('keydown', onKey); prev?.focus(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const o = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': name, onClick: close }, h('img', { src: url, alt: name }),
    h('button', { class: 'icon-btn lightbox-close', type: 'button', 'aria-label': 'Close', onClick: close }, icon('x')));
  document.addEventListener('keydown', onKey); document.body.append(o);
  (o.querySelector('button') as HTMLElement).focus();
}

// ---------- pending upload bubble ----------
export function uploadNode(u: Upload, retry: () => void): HTMLElement {
  const p = u.size ? u.done / u.size : 0;
  const cancel = h('button', { class: 'icon-btn tiny', type: 'button', 'aria-label': u.failed ? 'Dismiss' : 'Cancel upload', onClick: () => { u.abort.abort(); uploads.delete(u.id); notify(); } }, icon('x'));
  return h('div', { class: 'bubble-row mine pending enter last first' },
    h('div', { class: 'bubble' }, h('div', { class: 'file-card static' }, h('span', { class: 'file-icon' }, ring(u.failed ? 0 : p)),
      h('span', { class: 'file-meta' }, h('span', { class: 'name small' }, u.name), h('span', { class: 'small' }, u.failed ? 'Failed to send' : `${fmtSize(u.done)} of ${fmtSize(u.size)}`)), cancel)),
    u.failed ? h('button', { class: 'link-btn small', type: 'button', onClick: retry }, 'Dismiss') : null);
}

// ---------- voice recording ----------
export interface VoiceResult { file: File; duration: number; wave: number[] }
export class Recorder {
  private rec!: MediaRecorder; private stream!: MediaStream; private chunks: Blob[] = []; private started = 0;
  private ctx!: AudioContext; private analyser!: AnalyserNode; private peaks: number[] = []; private timer = 0;
  level: (v: number) => void = () => {};
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.ctx = new AudioContext(); this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 512;
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
    const buf = new Uint8Array(this.analyser.fftSize);
    this.timer = window.setInterval(() => { this.analyser.getByteTimeDomainData(buf); let max = 0; for (const v of buf) max = Math.max(max, Math.abs(v - 128)); const lv = Math.min(1, max / 90); this.peaks.push(lv); this.level(lv); }, 100);
    this.rec.start(250); this.started = Date.now();
  }
  get seconds() { return (Date.now() - this.started) / 1000; }
  private cleanup() { clearInterval(this.timer); this.stream?.getTracks().forEach((t) => t.stop()); void this.ctx?.close().catch(() => {}); }
  cancel() { try { this.rec.stop(); } catch { /* stopped */ } this.cleanup(); }
  async finish(): Promise<VoiceResult> {
    const duration = Math.max(1, Math.round(this.seconds));
    const done = new Promise<void>((r) => { this.rec.onstop = () => r(); });
    this.rec.stop(); await done; this.cleanup();
    const type = this.rec.mimeType || 'audio/webm';
    const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
    // shrink the recorded peaks to 40 bars for the waveform
    const bars = 40, wave = Array.from({ length: bars }, (_, i) => { const a = Math.floor((i / bars) * this.peaks.length), b = Math.max(a + 1, Math.floor(((i + 1) / bars) * this.peaks.length)); return Math.max(0.12, Math.round(Math.max(...this.peaks.slice(a, b), 0) * 100) / 100); });
    return { file: new File(this.chunks, `voice-${Date.now()}.${ext}`, { type: type.split(';')[0] }), duration, wave };
  }
}
