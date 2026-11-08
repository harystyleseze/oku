import { wsUrl } from "./api";

export interface PeerInfo {
  id: string;
  name: string;
  color: string;
  isHost: boolean;
}

export interface RecordingStart {
  conversationId: string;
  trackId: string;
  uploadToken: string;
}

export interface RoomEvents {
  onWelcome: (w: { peerId: string; isHost: boolean; color: string; roomTitle: string; recordingActive: boolean }) => void;
  onPeers: (peers: PeerInfo[]) => void;
  onRemoteStream: (peerId: string, stream: MediaStream | null) => void;
  onRecordingStarted: (r: RecordingStart) => void;
  onRecordingStopped: (conversationId: string) => void;
  onError: (message: string) => void;
  onClosed: () => void;
}

/**
 * One room connection: a WebSocket to the API for presence and signalling,
 * and a direct WebRTC audio link to every other person in the room (mesh).
 * The newcomer always sends the offer, so two peers never offer at once.
 */
export class RoomConnection {
  private ws: WebSocket | null = null;
  private peers = new Map<string, PeerInfo>();
  private pcs = new Map<string, RTCPeerConnection>();
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  private initiated = new Set<string>();
  private iceServers: RTCIceServer[] = [];
  private closed = false;

  constructor(
    private slug: string,
    private localStream: MediaStream,
    private events: RoomEvents,
  ) {}

  join(name: string) {
    const ws = new WebSocket(wsUrl(this.slug));
    this.ws = ws;
    ws.onopen = () => this.send({ type: "join", name, consent: true });
    ws.onmessage = (e) => void this.handle(JSON.parse(e.data));
    ws.onclose = () => {
      if (!this.closed) this.events.onClosed();
    };
    ws.onerror = () => this.events.onError("Could not connect to the room.");
  }

  startRecording(title?: string) {
    this.send({ type: "start-recording", title });
  }

  stopRecording() {
    this.send({ type: "stop-recording" });
  }

  reportRecorderStarted(mimeType: string) {
    this.send({ type: "recorder-started", mimeType });
  }

  leave() {
    this.closed = true;
    for (const pc of this.pcs.values()) pc.close();
    this.pcs.clear();
    this.ws?.close();
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async handle(msg: Record<string, unknown>) {
    switch (msg.type) {
      case "welcome": {
        this.iceServers = msg.iceServers as RTCIceServer[];
        for (const p of msg.peers as PeerInfo[]) this.peers.set(p.id, p);
        this.events.onWelcome({
          peerId: msg.peerId as string,
          isHost: msg.isHost as boolean,
          color: msg.color as string,
          roomTitle: msg.roomTitle as string,
          recordingActive: !!msg.recording,
        });
        this.events.onPeers([...this.peers.values()]);
        // We are the newcomer: call everyone already here.
        for (const p of this.peers.values()) await this.callPeer(p.id);
        return;
      }
      case "peer-joined": {
        const p = msg.peer as PeerInfo;
        this.peers.set(p.id, p);
        this.events.onPeers([...this.peers.values()]);
        return; // they will call us
      }
      case "peer-left": {
        const id = msg.peerId as string;
        this.peers.delete(id);
        this.pcs.get(id)?.close();
        this.pcs.delete(id);
        this.events.onRemoteStream(id, null);
        this.events.onPeers([...this.peers.values()]);
        return;
      }
      case "signal": {
        await this.onSignal(msg.from as string, msg.data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit });
        return;
      }
      case "recording-started":
        this.events.onRecordingStarted({
          conversationId: msg.conversationId as string,
          trackId: msg.trackId as string,
          uploadToken: msg.uploadToken as string,
        });
        return;
      case "recording-stopped":
        this.events.onRecordingStopped(msg.conversationId as string);
        return;
      case "error":
        this.events.onError(msg.message as string);
        return;
    }
  }

  private pcFor(peerId: string): RTCPeerConnection {
    let pc = this.pcs.get(peerId);
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: this.iceServers });
    for (const track of this.localStream.getAudioTracks()) pc.addTrack(track, this.localStream);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ type: "signal", to: peerId, data: { candidate: e.candidate.toJSON() } });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.events.onRemoteStream(peerId, stream);
    };
    pc.onconnectionstatechange = () => {
      // One retry on failure: the side that made the original offer restarts ICE.
      if (pc!.connectionState === "failed" && this.initiated.has(peerId)) void this.callPeer(peerId, true);
    };
    this.pcs.set(peerId, pc);
    return pc;
  }

  private async callPeer(peerId: string, iceRestart = false) {
    const pc = this.pcFor(peerId);
    this.initiated.add(peerId);
    const offer = await pc.createOffer({ iceRestart });
    await pc.setLocalDescription(offer);
    this.send({ type: "signal", to: peerId, data: { sdp: pc.localDescription } });
  }

  private async onSignal(from: string, data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
    const pc = this.pcFor(from);
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send({ type: "signal", to: from, data: { sdp: pc.localDescription } });
      }
      const queued = this.pendingCandidates.get(from) ?? [];
      this.pendingCandidates.delete(from);
      for (const c of queued) await pc.addIceCandidate(c).catch(() => {});
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else {
        const list = this.pendingCandidates.get(from) ?? [];
        list.push(data.candidate);
        this.pendingCandidates.set(from, list);
      }
    }
  }
}
