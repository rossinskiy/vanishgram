// Manual end-to-end check of the REAL WebRTC path in a browser: two accounts in one page call each
// other through the actual server, with a synthetic tone instead of a microphone.
// Build + serve: node e2e/build.mjs, then run the server with VG_WEB_DIR=apps/web/dist-e2e and open /call-test.html
import { VanishClient } from '@vanishgram/client-core';
import { createWebPeerFactory } from '../src/rtc.ts';

const out = document.getElementById('out')!;
const log = (s: string) => { out.textContent += s + '\n'; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 15000) => { const e = Date.now() + ms; while (!f()) { if (Date.now() > e) throw new Error('timeout'); await sleep(50); } };

function tone(): Promise<MediaStream> {
  const ctx = new AudioContext(); const osc = ctx.createOscillator(); const dest = ctx.createMediaStreamDestination();
  osc.frequency.value = 440; osc.connect(dest); osc.start();
  return Promise.resolve(dest.stream);
}

async function main() {
  const base = location.origin;
  const peers: any[] = [];
  const mk = createWebPeerFactory(tone);
  const factory = () => { const p = mk(); peers.push(p); return p; };
  const { client: alice } = await VanishClient.register(base);
  const { client: bob } = await VanishClient.register(base);
  for (const c of [alice, bob]) { c.calls.factory = factory; c.onError = (e) => log('ERROR ' + (e as Error).message); await c.connect(); }
  const m = await alice.sendText(bob.account.accountId, 'hello before the call');
  await until(() => !!bob.chats.get(alice.account.accountId)?.some((x) => x.id === m.id));
  log('chat established');

  await alice.calls.start(bob.account.accountId);
  await until(() => bob.calls.state?.status === 'incoming');
  log('bob is ringing');
  await bob.calls.accept();
  await until(() => alice.calls.state?.status === 'connected' && bob.calls.state?.status === 'connected', 20000);
  log('connected, codes: ' + alice.calls.state!.sas + ' / ' + bob.calls.state!.sas + ' equal=' + (alice.calls.state!.sas === bob.calls.state!.sas));

  await sleep(1500);
  const stats: string[] = [];
  for (const p of peers) {
    const rep = await p.pc.getStats(); let inBytes = 0, outBytes = 0, cipher = '', pair = '';
    rep.forEach((r: any) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') inBytes = r.bytesReceived;
      if (r.type === 'outbound-rtp' && r.kind === 'audio') outBytes = r.bytesSent;
      if (r.type === 'transport') cipher = `${r.dtlsState}/${r.srtpCipher}`;
      if (r.type === 'candidate-pair' && r.nominated) pair = r.state;
    });
    stats.push(`in=${inBytes} out=${outBytes} dtls=${cipher} pair=${pair}`);
  }
  log('peer stats: ' + stats.join(' | '));

  alice.calls.setMuted(true);
  const trackEnabled = peers[0].stream.getAudioTracks()[0].enabled;
  log('muted track enabled=' + trackEnabled);
  alice.calls.hangup();
  await until(() => !alice.calls.state && !bob.calls.state);
  log('ended; notes: ' + alice.chats.get(bob.account.accountId)!.filter((x) => x.sys).map((x) => x.body).join(',') + ' | ' + bob.chats.get(alice.account.accountId)!.filter((x) => x.sys).map((x) => x.body).join(','));
  await alice.http('DELETE', '/v1/account'); await bob.http('DELETE', '/v1/account');
  log('DONE');
}
main().catch((e) => log('FAILED ' + (e as Error).message));
