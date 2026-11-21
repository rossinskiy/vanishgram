// Client side of PUBLIC channels. Posts are plaintext and live on the server (that is what "public"
// means), so this manager mirrors server state. Private channels are E2EE groups where only admins
// post: they use GroupManager (groups-client.ts) and never pass through here.
import type { VanishClient, ChatMessage } from './client.ts';
import type { Role } from './groups-client.ts';

export interface PublicChannel {
  id: string; username: string; title: string; description: string; pinnedPost: string | null;
  subscribers: number; role: Role | null; lastSeq: number;
}
interface PostWire { id: string; seq: number; body: string; ts: number; edited: boolean; views: number; author?: string }

export const channelChatId = (id: string) => `c:${id}`;
const isAdmin = (r: Role | null) => r === 'owner' || r === 'admin';

export class ChannelManager {
  c: VanishClient;
  constructor(c: VanishClient) { this.c = c; }

  private touch() { this.c.onChange(); this.c.flushSoon(); }
  get(id: string): PublicChannel {
    const ch = this.c.channels.get(id);
    if (!ch) throw new Error('unknown channel');
    return ch;
  }
  isAdmin(id: string) { return isAdmin(this.c.channels.get(id)?.role ?? null); }

  private toMsg(id: string, p: PostWire): ChatMessage {
    return { id: p.id, from: id, body: p.body, ts: p.ts, serverIds: [], seq: p.seq, views: p.views, edited: p.edited };
  }

  private applyInfo(i: any): PublicChannel {
    const prev = this.c.channels.get(i.id);
    const ch: PublicChannel = {
      id: i.id, username: i.username, title: i.title, description: i.description, pinnedPost: i.pinnedPost ?? null,
      subscribers: i.subscribers, role: i.role, lastSeq: prev?.lastSeq ?? 0,
    };
    this.c.channels.set(i.id, ch);
    return ch;
  }

  /** Reconcile the newest page of posts: add, update views/edits, drop posts deleted while we were offline. */
  async sync(id: string) {
    const c = this.c;
    const info = await c.http<any>('GET', `/v1/channels/${id}`);
    const ch = this.applyInfo(info);
    const { posts, pinnedPost } = await c.http<{ posts: PostWire[]; pinnedPost: string | null }>('GET', `/v1/channels/${id}/posts?limit=50`);
    ch.pinnedPost = pinnedPost;
    const chat = channelChatId(id);
    const have = new Map((c.chats.get(chat) ?? []).map((m) => [m.id, m]));
    const minSeq = posts.length ? Math.min(...posts.map((p) => p.seq)) : Infinity;
    // A short page is the whole channel, so anything not in it was deleted. A full page leaves older history alone.
    const next = posts.length < 50 ? [] : [...have.values()].filter((m) => (m.seq ?? 0) < minSeq);
    for (const p of posts) { const prev = have.get(p.id); const m = this.toMsg(id, p); if (!prev) c.onMessage(chat, m); next.push(m); }
    c.chats.set(chat, next);
    ch.lastSeq = Math.max(ch.lastSeq, ...posts.map((p) => p.seq), 0);
    this.touch();
  }

  async lookup(username: string): Promise<PublicChannel> {
    const info = await this.c.http<any>('GET', `/v1/channels/by-name/${encodeURIComponent(username.replace(/^@/, ''))}`);
    this.applyInfo(info);
    await this.sync(info.id);
    return this.get(info.id);
  }

  async search(term: string): Promise<PublicChannel[]> {
    const { channels } = await this.c.http<{ channels: any[] }>('GET', `/v1/channels/search?q=${encodeURIComponent(term)}`);
    return channels.map((i) => ({ id: i.id, username: i.username, title: i.title, description: i.description, pinnedPost: i.pinnedPost ?? null, subscribers: i.subscribers, role: i.role, lastSeq: 0 }));
  }

  async create(opts: { title: string; username: string; description?: string }): Promise<string> {
    const { id } = await this.c.http<{ id: string }>('POST', '/v1/channels', { visibility: 'public', ...opts });
    await this.sync(id);
    return id;
  }

  async subscribe(id: string) {
    this.applyInfo(await this.c.http('POST', `/v1/channels/${id}/subscribe`));
    await this.sync(id);
  }

  async unsubscribe(id: string) {
    await this.c.http('POST', `/v1/groups/${id}/leave`);
    this.c.channels.delete(id); this.c.chats.delete(channelChatId(id)); this.c.muted.delete(channelChatId(id));
    this.touch();
  }

  async post(id: string, body: string) {
    if ([...body].length > 4096) throw new Error('post too long');
    const p = await this.c.http<PostWire>('POST', `/v1/channels/${id}/posts`, { body });
    this.upsert(id, p);
  }
  async edit(id: string, postId: string, body: string) { this.upsert(id, await this.c.http<PostWire>('PUT', `/v1/channels/${id}/posts/${postId}`, { body })); }
  async remove(id: string, postId: string) { await this.c.http('DELETE', `/v1/channels/${id}/posts/${postId}`); this.drop(id, postId); }
  async pin(id: string, postId: string | null) { await this.c.http('PUT', `/v1/channels/${id}/pin`, { postId }); this.get(id).pinnedPost = postId; this.touch(); }
  async update(id: string, patch: { title?: string; description?: string; username?: string }) { this.applyInfo(await this.c.http('PUT', `/v1/channels/${id}`, patch)); this.touch(); }
  async subscribers(id: string, offset = 0) { return (await this.c.http<{ subscribers: { accountId: string; role: Role }[] }>('GET', `/v1/channels/${id}/subscribers?offset=${offset}`)).subscribers; }

  /** Count a view once per post per account; the server dedupes too. */
  markViewed(id: string, postId: string) {
    if (this.c.viewed.has(postId)) return;
    this.c.viewed.add(postId);
    if (this.c.viewed.size > 5000) this.c.viewed = new Set([...this.c.viewed].slice(-2500));
    void this.c.http('POST', `/v1/channels/${id}/posts/${postId}/view`).catch(() => this.c.viewed.delete(postId));
  }

  private upsert(id: string, p: PostWire) {
    const chat = channelChatId(id), list = this.c.chats.get(chat) ?? [];
    const m = this.toMsg(id, p), i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = m; else { list.push(m); list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)); this.c.onMessage(chat, m); }
    this.c.chats.set(chat, list);
    const ch = this.c.channels.get(id); if (ch) ch.lastSeq = Math.max(ch.lastSeq, p.seq);
    this.touch();
  }
  private drop(id: string, postId: string) {
    const chat = channelChatId(id);
    this.c.chats.set(chat, (this.c.chats.get(chat) ?? []).filter((m) => m.id !== postId));
    const ch = this.c.channels.get(id); if (ch?.pinnedPost === postId) ch.pinnedPost = null;
    this.touch();
  }

  /** Live frames pushed over the WebSocket. */
  onFrame(f: any) {
    if (!this.c.channels.has(f.channelId)) return;
    if (f.type === 'channel-post' || f.type === 'channel-post-edit') this.upsert(f.channelId, f.post);
    else if (f.type === 'channel-post-delete') this.drop(f.channelId, f.postId);
    else if (f.type === 'channel-update') void this.sync(f.channelId).catch((e) => this.c.onError(e));
  }

  /** On (re)connect: refresh every public channel we belong to. */
  async syncMember(id: string) { try { await this.sync(id); } catch (e) { if ((e as any)?.status === 404) { this.c.channels.delete(id); this.touch(); } else throw e; } }
}
