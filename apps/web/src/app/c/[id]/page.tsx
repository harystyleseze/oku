"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CoverPreview } from "@/components/CoverPreview";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { TopBar } from "@/components/TopBar";
import { Waveform } from "@/components/Waveform";
import { API_URL, api, ApiError, formatDate, formatDuration, type Conversation, type Features, type Peaks, type Preset, type Transcript } from "@/lib/api";
import { useUser } from "@/lib/useUser";

export default function StudioPage() {
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useUser();
  const router = useRouter();

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [features, setFeatures] = useState<Features>({ transcription: false });
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Player
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [timeMs, setTimeMs] = useState(0);

  // Clip maker
  const [platform, setPlatform] = useState("tiktok");
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(60_000);
  const [clipTitle, setClipTitle] = useState("");
  const [theme, setTheme] = useState<"night" | "day">("night");
  const [captions, setCaptions] = useState(true);
  const [creating, setCreating] = useState(false);
  const [clipError, setClipError] = useState<string | null>(null);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const load = useCallback(async () => {
    const r = await api<{ conversation: Conversation }>(`/conversations/${id}`);
    setConversation(r.conversation);
    return r.conversation;
  }, [id]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace(`/login?next=/c/${id}`);
      return;
    }
    void load().catch((e) => setError(e instanceof ApiError ? e.message : "Could not load this conversation."));
    void api<{ presets: Preset[]; features: Features }>("/presets").then((r) => {
      setPresets(r.presets);
      setFeatures(r.features);
    });
  }, [user, loading, router, load, id]);

  // Poll while the server is still working on it.
  useEffect(() => {
    if (!conversation) return;
    const busy =
      conversation.status === "processing" ||
      conversation.status === "recording" ||
      conversation.transcriptStatus === "queued" ||
      conversation.transcriptStatus === "running" ||
      conversation.exports.some((e) => e.status === "queued" || e.status === "rendering");
    if (!busy) return;
    const t = setInterval(() => void load().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [conversation, load]);

  useEffect(() => {
    if (conversation?.status === "ready" && !peaks) {
      void api<Peaks>(`/conversations/${id}/peaks`).then((p) => {
        setPeaks(p);
        setEndMs(Math.min(p.durationMs, 60_000));
      });
    }
  }, [conversation, peaks, id]);

  useEffect(() => {
    if (conversation && !clipTitle) setClipTitle(conversation.title);
  }, [conversation, clipTitle]);

  useEffect(() => {
    if (conversation?.transcriptStatus === "ready" && !transcript) {
      void api<Transcript>(`/conversations/${id}/transcript`).then(setTranscript);
    }
  }, [conversation, transcript, id]);

  const preset = presets.find((p) => p.id === platform);
  const durationMs = conversation?.durationMs ?? 0;

  // Keep the clip inside the platform's limit when the platform changes.
  useEffect(() => {
    if (!preset?.maxSeconds) return;
    if (endMs - startMs > preset.maxSeconds * 1000) setEndMs(Math.min(durationMs, startMs + preset.maxSeconds * 1000));
  }, [preset, startMs, endMs, durationMs]);

  const waveTracks = useMemo(() => (peaks ? peaks.tracks.map((t) => ({ color: t.color, peaks: t.peaks })) : []), [peaks]);
  const clipTracks = useMemo(() => {
    if (!peaks || durationMs === 0) return [];
    const a = Math.floor((startMs / durationMs) * peaks.buckets);
    const b = Math.ceil((endMs / durationMs) * peaks.buckets);
    return peaks.tracks.map((t) => ({ color: t.color, peaks: t.peaks.slice(a, Math.max(a + 1, b)) }));
  }, [peaks, startMs, endMs, durationMs]);

  function seek(fraction: number) {
    const a = audioRef.current;
    if (!a || !durationMs) return;
    a.currentTime = (fraction * durationMs) / 1000;
    setTimeMs(fraction * durationMs);
  }

  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  }

  async function saveTitle() {
    if (!conversation) return;
    const title = titleDraft.trim();
    setEditingTitle(false);
    if (!title || title === conversation.title) return;
    const r = await api<{ conversation: Conversation }>(`/conversations/${id}`, { method: "PATCH", json: { title } });
    setConversation(r.conversation);
  }

  async function createClip() {
    setCreating(true);
    setClipError(null);
    try {
      await api(`/conversations/${id}/exports`, {
        method: "POST",
        json: {
          platform,
          startMs: Math.round(startMs),
          endMs: Math.round(endMs),
          title: clipTitle,
          theme,
          captions: captions && conversation?.transcriptStatus === "ready",
        },
      });
      await load();
    } catch (e) {
      setClipError(e instanceof ApiError ? e.message : "Could not start the export.");
    } finally {
      setCreating(false);
    }
  }

  async function deleteConversation() {
    if (!confirm("Delete this conversation and every clip made from it? This cannot be undone.")) return;
    await api(`/conversations/${id}`, { method: "DELETE" });
    router.push("/dashboard");
  }

  if (loading || !user) return <TopBar />;
  if (error) {
    return (
      <>
        <TopBar />
        <main className="shell page stack">
          <h1 style={{ fontSize: "2rem" }}>Not found</h1>
          <p className="muted">{error}</p>
          <Link href="/dashboard" className="btn secondary">
            Back to conversations
          </Link>
        </main>
      </>
    );
  }
  if (!conversation) return <TopBar />;

  const clipLen = endMs - startMs;
  const overLimit = preset?.maxSeconds ? clipLen > preset.maxSeconds * 1000 : false;
  const progress = durationMs ? timeMs / durationMs : 0;
  const clipProgress = playing && timeMs >= startMs && timeMs <= endMs ? (timeMs - startMs) / Math.max(1, clipLen) : undefined;

  return (
    <>
      <TopBar />
      <main className="shell page stack" style={{ gap: 36 }}>
        <section className="stack" style={{ gap: 8 }}>
          <Link href="/dashboard" className="muted small" style={{ textDecoration: "none" }}>
            ← Conversations
          </Link>
          {editingTitle ? (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void saveTitle();
              }}
            >
              <input className="input" style={{ maxWidth: 480, fontSize: "1.4rem" }} value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} autoFocus maxLength={120} />
              <button className="btn">Save</button>
              <button type="button" className="btn secondary" onClick={() => setEditingTitle(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <h1
              style={{ fontSize: "2rem", cursor: "text" }}
              title="Click to rename"
              onClick={() => {
                setTitleDraft(conversation.title);
                setEditingTitle(true);
              }}
            >
              {conversation.title}
            </h1>
          )}
          <div className="row muted small" style={{ gap: 14 }}>
            <span className="speakers">
              {conversation.participants.map((p) => (
                <span key={p.id} className="row" style={{ gap: 6 }}>
                  <span className="dot" style={{ background: p.color }} />
                  {p.displayName}
                </span>
              ))}
            </span>
            <span>{formatDate(conversation.startedAt)}</span>
            <span>{formatDuration(conversation.durationMs)}</span>
            <span className={`status ${conversation.status}`}>{conversation.status}</span>
          </div>
        </section>

        {conversation.status !== "ready" ? (
          <section className="panel stack">
            {conversation.status === "failed" ? (
              <>
                <h2>Processing failed</h2>
                <p className="muted">{conversation.error}</p>
              </>
            ) : conversation.status === "recording" ? (
              <>
                <h2>Waiting for everyone&apos;s audio</h2>
                <p className="muted">
                  Each person&apos;s device sends its own recording. Processing starts once they have all arrived, or
                  shortly after the recording stopped if someone dropped off.
                </p>
              </>
            ) : (
              <>
                <h2>Preparing your conversation</h2>
                <p className="muted">Lining up the voices, mixing them and drawing the waveform. This usually takes under a minute.</p>
              </>
            )}
          </section>
        ) : (
          <>
            <section className="panel stack">
              <div className="row between">
                <div className="row">
                  <button className="btn" onClick={togglePlay} style={{ minWidth: 92 }}>
                    {playing ? "Pause" : "Play"}
                  </button>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {formatDuration(timeMs)} <span className="muted">/ {formatDuration(durationMs)}</span>
                  </span>
                </div>
                <div className="row">
                  <a className="btn secondary" href={`${API_URL}/conversations/${id}/media/mixed?download=1`}>
                    Download full conversation
                  </a>
                  {conversation.participants.map((p) =>
                    p.track?.processedKey ? (
                      <a key={p.id} className="btn secondary" href={`${API_URL}/conversations/${id}/media/${p.id}?download=1`} style={{ color: p.color }}>
                        {p.displayName}&apos;s track
                      </a>
                    ) : null,
                  )}
                </div>
              </div>
              <Waveform
                tracks={waveTracks}
                height={Math.max(120, 60 * waveTracks.length)}
                progress={progress}
                selection={durationMs ? { start: startMs / durationMs, end: endMs / durationMs } : undefined}
                onSeek={seek}
              />
              <audio
                ref={audioRef}
                src={`${API_URL}/conversations/${id}/media/mixed`}
                crossOrigin="use-credentials"
                preload="metadata"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={(e) => setTimeMs(e.currentTarget.currentTime * 1000)}
              />
            </section>

            <section className="stack">
              <h2>Make a clip</h2>
              <div className="studio-grid">
                <div className="panel stack" style={{ gap: 18 }}>
                  <div className="field">
                    <label>Where will it go?</label>
                    <div className="segmented">
                      {presets.map((p) => (
                        <button key={p.id} type="button" className={p.id === platform ? "on" : ""} onClick={() => setPlatform(p.id)}>
                          {p.label}
                        </button>
                      ))}
                    </div>
                    {preset && <span className="muted small">{preset.note}</span>}
                  </div>

                  <div className="row" style={{ gap: 18 }}>
                    <TimeField label="Start" valueMs={startMs} max={durationMs} onChange={(v) => setStartMs(Math.min(v, endMs - 1000))} onUsePlayhead={() => setStartMs(Math.min(timeMs, endMs - 1000))} />
                    <TimeField label="End" valueMs={endMs} max={durationMs} onChange={(v) => setEndMs(Math.max(v, startMs + 1000))} onUsePlayhead={() => setEndMs(Math.max(timeMs, startMs + 1000))} />
                    <div className="field">
                      <label>Length</label>
                      <strong className={overLimit ? "error" : ""} style={{ fontSize: "1.1rem" }}>
                        {formatDuration(clipLen)}
                        {preset?.maxSeconds ? <span className="muted small"> of {formatDuration(preset.maxSeconds * 1000)} max</span> : null}
                      </strong>
                    </div>
                  </div>
                  <div className="row">
                    <button type="button" className="btn secondary" onClick={() => seek(startMs / durationMs)}>
                      Jump to start
                    </button>
                    {preset?.recommendedSeconds && (
                      <button type="button" className="btn secondary" onClick={() => setEndMs(Math.min(durationMs, startMs + preset.recommendedSeconds! * 1000))}>
                        Use {preset.recommendedSeconds}s from start
                      </button>
                    )}
                  </div>

                  <div className="field">
                    <label htmlFor="clip-title">Title on the cover</label>
                    <input id="clip-title" className="input" value={clipTitle} onChange={(e) => setClipTitle(e.target.value)} maxLength={120} />
                  </div>

                  <div className="field">
                    <label>Look</label>
                    <div className="segmented">
                      <button type="button" className={theme === "night" ? "on" : ""} onClick={() => setTheme("night")}>
                        Night
                      </button>
                      <button type="button" className={theme === "day" ? "on" : ""} onClick={() => setTheme("day")}>
                        Day
                      </button>
                    </div>
                  </div>

                  {conversation.transcriptStatus === "ready" && (
                    <label className="checkbox">
                      <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />
                      <span>Burn in captions, coloured by speaker</span>
                    </label>
                  )}

                  {clipError && <p className="error">{clipError}</p>}
                  <div>
                    <button className="btn large" onClick={createClip} disabled={creating || overLimit || !clipTitle.trim()}>
                      {creating ? "Starting" : "Create clip"}
                    </button>
                  </div>
                </div>

                <div className="stack" style={{ gap: 8 }}>
                  <span className="muted small">Preview</span>
                  {preset && (
                    <CoverPreview
                      width={preset.width}
                      height={preset.height}
                      title={clipTitle}
                      theme={theme}
                      speakers={conversation.participants.map((p) => ({ name: p.displayName, color: p.color }))}
                      tracks={clipTracks}
                      progress={clipProgress}
                    />
                  )}
                </div>
              </div>
            </section>

            <TranscriptPanel
              conversation={conversation}
              transcript={transcript}
              transcriptionAvailable={features.transcription}
              timeMs={timeMs}
              onSeek={(ms) => seek(ms / durationMs)}
              onSetStart={(ms) => setStartMs(Math.min(ms, endMs - 1000))}
              onSetEnd={(ms) => setEndMs(Math.max(ms, startMs + 1000))}
              onTranscribe={async () => {
                await api(`/conversations/${id}/transcribe`, { method: "POST" });
                await load();
              }}
            />

            <section className="stack">
              <h2>Clips</h2>
              {conversation.exports.length === 0 ? (
                <div className="panel muted">Clips you create appear here, ready to download and post.</div>
              ) : (
                <div className="list">
                  {conversation.exports.map((e) => {
                    const p = presets.find((x) => x.id === e.platform);
                    return (
                      <div key={e.id} className="list-row">
                        <div>
                          <strong>{e.title}</strong>
                          <div className="muted small">
                            {p?.label ?? e.platform} · {formatDuration(e.startMs)}–{formatDuration(e.endMs)} ({formatDuration(e.endMs - e.startMs)}) · {e.theme}
                            {e.captions ? " · captions" : ""}
                          </div>
                          {e.status === "failed" && <div className="error">{e.error}</div>}
                        </div>
                        <div className="row">
                          {e.status === "ready" ? (
                            <a className="btn" href={`${API_URL}/exports/${e.id}/download`}>
                              Download MP4
                            </a>
                          ) : (
                            <span className={`status ${e.status === "failed" ? "failed" : ""}`}>{e.status === "queued" ? "Queued" : e.status === "rendering" ? "Rendering" : "Failed"}</span>
                          )}
                          <button
                            className="btn secondary"
                            onClick={async () => {
                              await api(`/exports/${e.id}`, { method: "DELETE" });
                              await load();
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}

        <section className="row between" style={{ marginTop: 24 }}>
          <Link href={`/r/${conversation.room.slug}`} className="muted small">
            Back to the room “{conversation.room.title}”
          </Link>
          <button className="btn danger" onClick={deleteConversation}>
            Delete conversation
          </button>
        </section>
      </main>
    </>
  );
}

function TimeField({ label, valueMs, max, onChange, onUsePlayhead }: { label: string; valueMs: number; max: number; onChange: (ms: number) => void; onUsePlayhead: () => void }) {
  const [text, setText] = useState(formatDuration(valueMs));
  useEffect(() => setText(formatDuration(valueMs)), [valueMs]);
  function commit() {
    const ms = parseTime(text);
    if (ms == null) return setText(formatDuration(valueMs));
    onChange(Math.max(0, Math.min(max, ms)));
  }
  return (
    <div className="field">
      <label>{label}</label>
      <div className="row" style={{ gap: 6 }}>
        <input className="input" style={{ width: 96, fontVariantNumeric: "tabular-nums" }} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} aria-label={`${label} time`} />
        <button type="button" className="btn secondary" onClick={onUsePlayhead} title="Use the current playback position">
          Playhead
        </button>
      </div>
    </div>
  );
}

function parseTime(s: string): number | null {
  const parts = s.trim().split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const [a = 0, b = 0, c = 0] = parts.length === 1 ? [0, 0, parts[0]] : parts.length === 2 ? [0, parts[0], parts[1]] : parts;
  return (a * 3600 + b * 60 + c) * 1000;
}
