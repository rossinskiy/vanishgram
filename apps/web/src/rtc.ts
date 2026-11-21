// Browser WebRTC adapter for the call state machine in client-core.
// Audio is DTLS-SRTP encrypted end to end; the fingerprints that authenticate it travel inside E2EE signaling.
import type { CallPeer, IceCand, PeerState } from '@vanishgram/client-core';

export interface Devices { mics: MediaDeviceInfo[]; speakers: MediaDeviceInfo[] }
export const speakerSelectionSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

const prefs: { micId: string | null; speakerId: string | null } = { micId: null, speakerId: null };
let remoteAudio: HTMLAudioElement | null = null;

function audioEl(): HTMLAudioElement {
  if (!remoteAudio) {
    remoteAudio = document.createElement('audio');
    remoteAudio.autoplay = true; remoteAudio.setAttribute('playsinline', ''); remoteAudio.hidden = true;
    document.body.append(remoteAudio);
  }
  return remoteAudio;
}

export async function listAudioDevices(): Promise<Devices> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return { mics: all.filter((d) => d.kind === 'audioinput'), speakers: all.filter((d) => d.kind === 'audiooutput') };
}
export async function setSpeaker(id: string) {
  prefs.speakerId = id;
  if (speakerSelectionSupported) await (audioEl() as any).setSinkId(id).catch(() => {});
}
export const currentSpeaker = () => prefs.speakerId;

const mapState = (s: RTCPeerConnectionState): PeerState =>
  s === 'connected' ? 'connected' : s === 'disconnected' ? 'disconnected' : s === 'failed' ? 'failed' : s === 'closed' ? 'closed' : 'connecting';

class WebPeer implements CallPeer {
  pc: RTCPeerConnection | null = null;
  stream: MediaStream | null = null;
  private getStream: () => Promise<MediaStream>;
  onIce: (c: IceCand) => void = () => {};
  onState: (s: PeerState) => void = () => {};
  constructor(getStream?: () => Promise<MediaStream>) {
    this.getStream = getStream ?? (() => navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(prefs.micId ? { deviceId: { exact: prefs.micId } } : {}) },
    }));
  }

  async start(ice: { urls: string[]; username?: string; credential?: string }[], relayOnly: boolean) {
    this.stream = await this.getStream(); // asks for microphone permission; throws if denied
    const pc = new RTCPeerConnection({ iceServers: ice, iceTransportPolicy: relayOnly ? 'relay' : 'all', bundlePolicy: 'max-bundle' });
    this.pc = pc;
    this.stream.getAudioTracks().forEach((t) => pc.addTrack(t, this.stream!));
    pc.onicecandidate = (e) => { if (e.candidate) this.onIce({ candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex }); };
    pc.onconnectionstatechange = () => this.onState(mapState(pc.connectionState));
    pc.ontrack = (e) => {
      const el = audioEl();
      el.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      if (prefs.speakerId && speakerSelectionSupported) void (el as any).setSinkId(prefs.speakerId).catch(() => {});
      void el.play().catch(() => {});
    };
  }
  async createOffer() { const o = await this.pc!.createOffer(); await this.pc!.setLocalDescription(o); return o.sdp!; }
  async createAnswer(offerSdp: string) {
    await this.pc!.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const a = await this.pc!.createAnswer(); await this.pc!.setLocalDescription(a); return a.sdp!;
  }
  async setAnswer(sdp: string) { await this.pc!.setRemoteDescription({ type: 'answer', sdp }); }
  async addIce(c: IceCand) { await this.pc!.addIceCandidate(c); }
  setMuted(m: boolean) { this.stream?.getAudioTracks().forEach((t) => { t.enabled = !m; }); }
  close() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.pc?.close();
    if (remoteAudio) { remoteAudio.srcObject = null; }
    this.stream = null; this.pc = null;
  }
}

export const createWebPeerFactory = (getStream?: () => Promise<MediaStream>) => () => new WebPeer(getStream);
export const callsSupported = () => typeof RTCPeerConnection !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
