"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { LiveMeter } from "@/components/LiveMeter";
import { api, ApiError, formatDuration } from "@/lib/api";
import { LocalRecorder, resumePendingUploads, type RecorderProgress } from "@/lib/recorder";
import { RoomConnection, type PeerInfo, type RecordingStart } from "@/lib/rtc";
import { useUser } from "@/lib/useUser";

interface RoomInfo {
  slug: string;
  title: string;
  hostName: string;
  isHost: boolean;
}

type Stage = "lobby" | "connecting" | "live" | "left";

export default function RoomPage() {
  const { slug } = useParams<{ slug: string }>();
  const { user, loading: userLoading } = useUser();

  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("lobby");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [me, setMe] = useState<{ peerId: string; isHost: boolean; color: string } | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [muted, setMuted] = useState(false);

  const [recording, setRecording] = useState<RecordingStart | null>(null);
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState<RecorderProgress | null>(null);
  const [finished, setFinished] = useState<string | null>(null); // conversationId once stopped
  const [clipTitle, setClipTitle] = useState("");

  const localStream = useRef<MediaStream | null>(null);
  const connection = useRef<RoomConnection | null>(null);
  const recorder = useRef<LocalRecorder | null>(null);

  useEffect(() => {
    document.body.classList.add("night");
    void resumePendingUploads();
    return () => document.body.classList.remove("night");
  }, []);

  useEffect(() => {
    api<{ room: RoomInfo }>(`/rooms/${slug}`)
      .then((r) => setRoom(r.room))
      .catch((e) => setRoomError(e instanceof ApiError ? e.message : "Could not load this room."));
  }, [slug, user]);

  useEffect(() => {
    if (user && !name) setName(user.displayName);
  }, [user, name]);

  useEffect(() => {
    if (!recordingSince) return;
    const t = setInterval(() => setElapsed(Date.now() - recordingSince), 500);
    return () => clearInterval(t);
  }, [recordingSince]);

  // Don't let the tab close while audio is still being sent.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (progress && progress.state !== "done" && progress.state !== "idle") e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [progress]);

  const startLocalRecording = useCallback(async (r: RecordingStart) => {
    if (!localStream.current || !connection.current) return;
    const rec = new LocalRecorder(localStream.current, r.trackId, r.uploadToken);
    rec.onProgress = setProgress;
    recorder.current = rec;
    await rec.start();
    connection.current.reportRecorderStarted(rec.mimeType);
    setRecording(r);
    setRecordingSince(Date.now());
    setFinished(null);
  }, []);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStage("connecting");
    try {
      localStream.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
    } catch {
      setError("Oku needs your microphone to join. Allow microphone access in your browser and try again.");
      setStage("lobby");
      return;
    }
    const conn = new RoomConnection(slug, localStream.current, {
      onWelcome: (w) => {
        setMe({ peerId: w.peerId, isHost: w.isHost, color: w.color });
        setStage("live");
      },
      onPeers: setPeers,
      onRemoteStream: (peerId, stream) =>
        setStreams((s) => {
          const next = { ...s };
          if (stream) next[peerId] = stream;
          else delete next[peerId];
          return next;
        }),
      onRecordingStarted: (r) => void startLocalRecording(r),
      onRecordingStopped: (conversationId) => {
        setRecording(null);
        setRecordingSince(null);
        setFinished(conversationId);
        void recorder.current?.stopAndFinish();
      },
      onError: setError,
      onClosed: () => setError("You were disconnected from the room. Reload the page to rejoin."),
    });
    connection.current = conn;
    conn.join(name.trim());
  }

  function toggleMute() {
    const track = localStream.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = muted;
    setMuted(!muted);
  }

  function leave() {
    connection.current?.leave();
    localStream.current?.getTracks().forEach((t) => t.stop());
    setStage("left");
  }

  if (roomError) {
    return (
      <Shell>
        <h1 style={{ fontSize: "2rem" }}>This link isn&apos;t valid</h1>
        <p className="muted">{roomError}</p>
        <Link href="/" className="btn secondary">
          Go to Oku
        </Link>
      </Shell>
    );
  }
  if (!room || userLoading) return <Shell />;

  if (stage === "left") {
    return (
      <Shell>
        <h1 style={{ fontSize: "2rem" }}>You left {room.title}</h1>
        {progress && progress.state !== "done" && progress.state !== "idle" ? (
          <p className="muted">Still sending your audio ({progress.uploaded}/{progress.produced}). Keep this tab open a moment.</p>
        ) : finished ? (
          room.isHost ? (
            <Link href={`/c/${finished}`} className="btn large">
              Open in Studio
            </Link>
          ) : (
            <p className="muted">Your audio is saved. Thanks for talking.</p>
          )
        ) : null}
        <button className="btn secondary" onClick={() => window.location.reload()}>
          Rejoin
        </button>
      </Shell>
    );
  }

  if (stage !== "live") {
    return (
      <Shell>
        <div className="stack" style={{ gap: 6 }}>
          <span className="muted">{room.isHost ? "Your room" : `${room.hostName}'s room`}</span>
          <h1 style={{ fontSize: "2.2rem" }}>{room.title}</h1>
        </div>
        <form className="stack" style={{ maxWidth: 440, gap: 18 }} onSubmit={join}>
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} />
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required />
            <span>
              I understand that {room.isHost ? "I" : room.hostName} can record this conversation, that everyone sees a
              recording indicator while it is on, and that {room.isHost ? "I own" : `${room.hostName} owns`} the recording.
            </span>
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn large" disabled={!consent || stage === "connecting"}>
            {stage === "connecting" ? "Connecting" : "Join with microphone"}
          </button>
          <p className="muted small">Audio only. Nothing is recorded until the host presses Record.</p>
        </form>
      </Shell>
    );
  }

  const everyone: PeerInfo[] = me ? [{ id: me.peerId, name: name.trim(), color: me.color, isHost: me.isHost }, ...peers] : peers;

  return (
    <Shell wide>
      <div className="row between">
        <div>
          <span className="muted small">{room.isHost ? "Your room" : `${room.hostName}'s room`}</span>
          <h1 style={{ fontSize: "1.6rem" }}>{room.title}</h1>
        </div>
        <div className="row">
          {recording ? (
            <span className="rec-indicator">
              <i /> Recording {formatDuration(elapsed)}
            </span>
          ) : (
            <span className="muted small">Not recording</span>
          )}
        </div>
      </div>

      <div className="tiles">
        {everyone.map((p) => (
          <div key={p.id} className="tile" style={{ borderColor: p.color }}>
            <div className="row between">
              <strong style={{ color: p.color }}>
                {p.name}
                {p.id === me?.peerId ? " (you)" : ""}
              </strong>
              {p.isHost && <span className="muted small">Host</span>}
            </div>
            <LiveMeter stream={p.id === me?.peerId ? localStream.current : (streams[p.id] ?? null)} color={p.color} />
            {p.id !== me?.peerId && <RemoteAudio stream={streams[p.id]} />}
          </div>
        ))}
        {everyone.length === 1 && (
          <div className="tile waiting">
            <p className="muted">Waiting for others. Share this page&apos;s link to invite them.</p>
            <button
              className="btn secondary"
              onClick={() => navigator.clipboard.writeText(window.location.href).catch(() => {})}
            >
              Copy invite link
            </button>
          </div>
        )}
      </div>

      <div className="controls">
        <div className="row">
          <button className="btn secondary" onClick={toggleMute}>
            {muted ? "Unmute" : "Mute"}
          </button>
          <button className="btn secondary" onClick={leave}>
            Leave
          </button>
        </div>
        {me?.isHost && (
          <div className="row">
            {recording ? (
              <button className="btn" onClick={() => connection.current?.stopRecording()}>
                Stop recording
              </button>
            ) : (
              <>
                <input
                  className="input"
                  style={{ maxWidth: 260 }}
                  placeholder="Title (optional)"
                  value={clipTitle}
                  onChange={(e) => setClipTitle(e.target.value)}
                  maxLength={120}
                />
                <button className="btn record" onClick={() => connection.current?.startRecording(clipTitle || undefined)}>
                  Record
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {progress && progress.state !== "idle" && (
        <p className={progress.state === "stuck" ? "error" : "muted small"}>
          {progress.state === "recording" && `Saving your audio as you talk (${progress.uploaded}/${progress.produced} parts sent).`}
          {progress.state === "uploading" && `Sending the last parts (${progress.uploaded}/${progress.produced}).`}
          {progress.state === "stuck" && progress.warning}
          {progress.state === "done" && "Your audio is saved."}
        </p>
      )}

      {finished && me?.isHost && (
        <div className="row">
          <Link href={`/c/${finished}`} className="btn large">
            Open in Studio
          </Link>
          <span className="muted small">Processing starts as soon as everyone&apos;s audio has arrived.</span>
        </div>
      )}
      {error && <p className="error">{error}</p>}

    </Shell>
  );
}

function RemoteAudio({ stream }: { stream?: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream;
      void ref.current.play().catch(() => {});
    }
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline style={{ display: "none" }} />;
}

function Shell({ children, wide }: { children?: React.ReactNode; wide?: boolean }) {
  return (
    <main className="shell page stack" style={{ gap: 24, maxWidth: wide ? 1040 : 720, paddingTop: 40 }}>
      <Link href="/" className="wordmark" style={{ color: "var(--night-text)" }}>
        <i aria-hidden /> oku
      </Link>
      {children}
    </main>
  );
}
