// Moving chat history from an old device to a new one. Keys never move: the new device has its own keys. What moves is the
// readable history (chats, contacts, settings), packed on the OLD device, encrypted as a file under a fresh key, and handed to
// the new device through the normal end-to-end channel between the account's own devices. The old device's owner must approve.
import type { Envelope, FileInfo, ChatPrefs } from '@vanishgram/protocol';
import { utf8, fromUtf8 } from './encoding.ts';
import { encodeState, decodeState } from './serialize.ts';
import { fromBytes, memorySink } from './files-client.ts';
import type { VanishClient, ChatMessage, Contact } from './client.ts';

interface Pack {
  v: 1;
  chats: Map<string, ChatMessage[]>; contacts: Map<string, Contact>; tombstones: Set<string>; muted: Set<string>;
  prefs: ChatPrefs; ttl: Map<string, { seconds: number; ts: number }>;
}
export interface HistoryRequest { deviceId: string; label: string }

export class HistoryManager {
  c: VanishClient;
  /** Set by the app: called on an OLD device when another device of the same account asks for the history. */
  onRequest: (req: HistoryRequest, approve: () => Promise<void>, refuse: () => void) => void = () => {};
  /** Called on the NEW device after the history was merged in. */
  onImported: (messages: number) => void = () => {};
  private sentTo = new Set<string>();
  constructor(c: VanishClient) { this.c = c; }

  /** New device: ask the account's other devices. Returns how many devices were asked. */
  async request(): Promise<number> {
    const others = (await this.c.http<{ devices: { deviceId: string; current: boolean }[] }>('GET', '/v1/devices')).devices.filter((d) => !d.current);
    if (!others.length) return 0;
    await this.c.deliver(this.c.account.accountId, { t: 'history-request', ts: Date.now() });
    return others.length;
  }

  private pack(): Pack {
    const c = this.c;
    // message copies without server ids: those belong to this device's queue and mean nothing elsewhere
    const chats = new Map([...c.chats].map(([k, v]) => [k, v.map((m) => ({ ...m, serverIds: [] }))]));
    return { v: 1, chats, contacts: c.contacts, tombstones: c.tombstones, muted: c.muted, prefs: c.prefs, ttl: c.ttl };
  }

  /** Old device: someone with this account's keys asked. Nothing leaves until the owner approves. */
  async onEnvelope(from: string, fromDevice: string, env: Envelope) {
    const c = this.c;
    if (from !== c.account.accountId || fromDevice === c.device.deviceId) return; // only my own other devices may ask or answer
    if (env.t === 'history-request') {
      if (this.sentTo.has(fromDevice)) return;
      const label = (await c.http<{ devices: { deviceId: string; label: string }[] }>('GET', '/v1/devices').catch(() => ({ devices: [] }))).devices.find((d) => d.deviceId === fromDevice)?.label ?? 'another device';
      this.onRequest({ deviceId: fromDevice, label }, async () => { this.sentTo.add(fromDevice); await this.send(fromDevice); }, () => {});
    } else if (env.t === 'history' && env.to === c.device.deviceId) {
      await this.receive(env.file);
    }
  }

  private async send(toDevice: string) {
    const c = this.c;
    const bytes = utf8(encodeState(this.pack()));
    const info = await c.files.upload(fromBytes(bytes), { name: 'history', mime: 'application/octet-stream', kind: 'file' });
    await c.deliver(c.account.accountId, { t: 'history', file: info, to: toDevice, ts: Date.now() }, toDevice);
  }

  private async receive(info: FileInfo) {
    const c = this.c;
    const sink = memorySink();
    await c.files.download(info, sink);
    let pack: Pack;
    try { pack = decodeState<Pack>(fromUtf8(sink.bytes())); } catch { throw new Error('the history file is not readable'); }
    if (pack.v !== 1 || !(pack.chats instanceof Map)) throw new Error('unsupported history file');
    let added = 0;
    for (const id of pack.tombstones ?? []) c.tombstones.add(id);
    for (const [peer, msgs] of pack.chats) {
      if (typeof peer !== 'string' || !Array.isArray(msgs)) continue;
      const mine = c.chats.get(peer) ?? [];
      const have = new Set(mine.map((m) => m.id));
      for (const m of msgs) {
        if (!m || typeof m.id !== 'string' || have.has(m.id) || c.tombstones.has(m.id)) continue;
        mine.push({ ...m, serverIds: [] }); added++;
      }
      mine.sort((a, b) => a.ts - b.ts);
      c.chats.set(peer, mine);
    }
    for (const [id, ct] of pack.contacts ?? []) if (!c.contacts.has(id)) c.contacts.set(id, ct);
    for (const id of pack.muted ?? []) c.muted.add(id);
    for (const [k, v] of pack.ttl ?? []) if (!c.ttl.has(k)) c.ttl.set(k, v);
    const p = pack.prefs, mine = c.prefs;
    if (p && !mine.pinned.length && !mine.archived.length && !mine.folders.length) c.prefs = p; // keep chat organisation if this device has none yet
    c.onChange(); await c.flush();
    void c.files.release(info.fileId);
    this.onImported(added);
  }
}
