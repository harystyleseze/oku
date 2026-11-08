"use client";

import { useEffect, useState } from "react";
import { formatDuration, type Conversation, type Highlight, type Preset } from "@/lib/api";

const CATEGORY_LABEL: Record<Highlight["category"], string> = {
  funny: "Funny",
  emotional: "Emotional",
  insight: "Insight",
  story: "Story",
  debate: "Debate",
  advice: "Advice",
};

interface Props {
  conversation: Conversation;
  preset: Preset | undefined;
  playingRange: { startMs: number; endMs: number } | null;
  onPlay: (h: Highlight) => void;
  onUse: (h: Highlight) => void;
  onMakeAll: () => Promise<void>;
  onFind: () => Promise<void>;
}

/**
 * "Your producer found N moments": the AI's suggestions, each one a clip away.
 * Hidden entirely when the server has no highlights model configured.
 */
export function MomentsPanel({ conversation, preset, playingRange, onPlay, onUse, onMakeAll, onFind }: Props) {
  const [busy, setBusy] = useState<"all" | "find" | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [made, setMade] = useState(false);
  // A new platform means a new set of clips can be made.
  useEffect(() => setMade(false), [preset?.id]);
  const status = conversation.highlightsStatus;
  const moments = conversation.highlights ?? [];

  async function run(kind: "all" | "find", fn: () => Promise<void>) {
    setBusy(kind);
    try {
      await fn();
      if (kind === "all") setMade(true);
    } finally {
      setBusy(null);
    }
  }

  if (conversation.transcriptStatus !== "ready") {
    return (
      <section className="panel stack">
        <h2>Moments</h2>
        <p className="muted">Once the transcript is ready, your producer reads the conversation and picks the moments worth sharing.</p>
      </section>
    );
  }

  if (status === "queued" || status === "running") {
    return (
      <section className="panel stack">
        <h2>Moments</h2>
        <p className="muted">Your producer is reading the conversation and picking the moments worth sharing.</p>
      </section>
    );
  }

  if (status !== "ready") {
    return (
      <section className="panel stack">
        <h2>Moments</h2>
        {status === "failed" && <p className="error">{conversation.highlightsError ?? "Finding moments failed."}</p>}
        <div>
          <button className="btn" disabled={busy !== null} onClick={() => run("find", onFind)}>
            {status === "failed" ? "Try again" : "Find moments"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="stack">
      <div className="row between">
        <div className="stack" style={{ gap: 4 }}>
          <h2>Moments</h2>
          <span className="muted small">
            {moments.length === 0
              ? "Your producer didn't find a moment that stands on its own."
              : `Your producer found ${moments.length} moment${moments.length === 1 ? "" : "s"} worth sharing.`}
          </span>
        </div>
        <div className="row">
          <button className="btn secondary" disabled={busy !== null} onClick={() => run("find", onFind)}>
            Find again
          </button>
          {moments.length > 0 && preset && (
            <button className="btn" disabled={busy !== null || made} onClick={() => run("all", onMakeAll)}>
              {busy === "all" ? "Starting" : made ? "Clips started below" : `Make ${moments.length} ${preset.label} clip${moments.length === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      </div>

      {moments.length === 0 ? (
        <div className="panel muted">Try again, or set a clip from any line in the transcript below.</div>
      ) : (
        <div className="list">
          {moments.map((h, i) => {
            const playing = playingRange?.startMs === h.startMs && playingRange.endMs === h.endMs;
            return (
              <div key={`${h.startMs}-${i}`} className="moment">
                <div className="stack" style={{ gap: 6 }}>
                  <div className="row" style={{ gap: 10 }}>
                    <span className="status">{CATEGORY_LABEL[h.category] ?? h.category}</span>
                    <span className="muted small" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {formatDuration(h.startMs)} · {Math.round((h.endMs - h.startMs) / 1000)}s
                    </span>
                  </div>
                  <strong className="moment-title">{h.title}</strong>
                  {h.why && <p className="muted small">{h.why}</p>}
                  {h.post && (
                    <div className="moment-post">
                      <p className="small">{h.post}</p>
                      <button
                        className="link-button small"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(h.post);
                            setCopied(i);
                            setTimeout(() => setCopied(null), 1600);
                          } catch {
                            window.prompt("Copy this post", h.post);
                          }
                        }}
                      >
                        {copied === i ? "Copied" : "Copy post"}
                      </button>
                    </div>
                  )}
                </div>
                <div className="moment-actions">
                  <button className="btn secondary" onClick={() => onPlay(h)}>
                    {playing ? "Playing" : "Play"}
                  </button>
                  <button className="btn" onClick={() => onUse(h)}>
                    Use for clip
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
