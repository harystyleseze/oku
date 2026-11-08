"use client";

import { useMemo, useState } from "react";
import { API_URL, formatDuration, type Conversation, type Transcript } from "@/lib/api";

interface Props {
  conversation: Conversation;
  transcript: Transcript | null;
  transcriptionAvailable: boolean;
  timeMs: number;
  onSeek: (ms: number) => void;
  onSetStart: (ms: number) => void;
  onSetEnd: (ms: number) => void;
  onTranscribe: () => Promise<void>;
}

/**
 * The conversation as text, by speaker. Click a line to jump there; use a line
 * as the start or end of a clip; search to find the moment you remember.
 */
export function TranscriptPanel({ conversation, transcript, transcriptionAvailable, timeMs, onSeek, onSetStart, onSetEnd, onTranscribe }: Props) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const speakers = useMemo(() => new Map(transcript?.speakers.map((s) => [s.participantId, s]) ?? []), [transcript]);
  const visible = useMemo(() => {
    if (!transcript) return [];
    const q = query.trim().toLowerCase();
    return q ? transcript.segments.filter((s) => s.text.toLowerCase().includes(q)) : transcript.segments;
  }, [transcript, query]);

  const status = conversation.transcriptStatus;

  if (status !== "ready") {
    return (
      <section className="panel stack">
        <h2>Transcript</h2>
        {!transcriptionAvailable ? (
          <p className="muted">
            Transcription isn&apos;t set up on this server yet. Add a transcription key to the API (see <code>apps/api/.env.example</code>) to get
            transcripts, searchable moments and captions on clips.
          </p>
        ) : status === "queued" || status === "running" ? (
          <p className="muted">Writing the transcript. Each voice is transcribed on its own, so speaker names are exact. This takes a minute or two.</p>
        ) : (
          <>
            {status === "failed" && <p className="error">{conversation.transcriptError ?? "Transcription failed."}</p>}
            <div>
              <button
                className="btn"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onTranscribe();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {status === "failed" ? "Try again" : "Transcribe this conversation"}
              </button>
            </div>
          </>
        )}
      </section>
    );
  }

  return (
    <section className="panel stack">
      <div className="row between">
        <h2>Transcript</h2>
        <div className="row">
          <a className="btn secondary" href={`${API_URL}/conversations/${conversation.id}/transcript.txt`}>
            Download .txt
          </a>
          <a className="btn secondary" href={`${API_URL}/conversations/${conversation.id}/transcript.srt`}>
            Download .srt
          </a>
        </div>
      </div>
      <input className="input" placeholder="Search for a moment" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the transcript" />
      {visible.length === 0 ? (
        <p className="muted">{query ? "Nothing matches that." : "No speech was detected."}</p>
      ) : (
        <div className="transcript">
          {visible.map((seg, i) => {
            const sp = speakers.get(seg.participantId);
            const active = timeMs >= seg.start && timeMs < seg.end;
            return (
              <div key={i} className={`t-line${active ? " active" : ""}`} style={{ borderLeftColor: sp?.color ?? "var(--line)" }}>
                <div className="t-meta">
                  <button className="t-time" onClick={() => onSeek(seg.start)} title="Play from here">
                    {formatDuration(seg.start)}
                  </button>
                  <span style={{ color: sp?.color }}>{sp?.name ?? "Speaker"}</span>
                  <span className="t-actions">
                    <button onClick={() => onSetStart(seg.start)}>Start here</button>
                    <button onClick={() => onSetEnd(seg.end)}>End here</button>
                  </span>
                </div>
                <p className="t-text">
                  {seg.words.length
                    ? seg.words.map((w, k) => (
                        <span key={k} className={timeMs >= w.s && timeMs < w.e ? "t-word on" : "t-word"} onClick={() => onSeek(w.s)}>
                          {w.w}{" "}
                        </span>
                      ))
                    : seg.text}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
