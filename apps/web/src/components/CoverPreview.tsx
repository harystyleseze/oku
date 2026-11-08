"use client";

import { Waveform, type WaveTrack } from "./Waveform";

interface Props {
  width: number;
  height: number;
  title: string;
  theme: "night" | "day";
  speakers: { name: string; color: string }[];
  tracks: WaveTrack[];
  /** Playhead within the clip, 0..1, when previewing playback. */
  progress?: number;
}

const THEMES = {
  night: { background: "#0F1017", text: "#FFFFFF", muted: "#9A9DAB" },
  day: { background: "#F3F2ED", text: "#171A2B", muted: "#6D7083" },
};

/** What the exported video will look like, at the chosen platform's aspect ratio. */
export function CoverPreview({ width, height, title, theme, speakers, tracks, progress }: Props) {
  const t = THEMES[theme];
  const portrait = height > width;
  return (
    <div
      style={{
        aspectRatio: `${width} / ${height}`,
        background: t.background,
        color: t.text,
        borderRadius: 10,
        padding: "8%",
        display: "grid",
        gridTemplateRows: "auto 1fr auto",
        gap: 12,
        maxHeight: portrait ? 520 : undefined,
        width: "100%",
        overflow: "hidden",
        fontFamily: "var(--font)",
      }}
    >
      <div
        style={{
          fontSize: portrait ? "clamp(1rem, 2.6vw, 1.5rem)" : "clamp(1rem, 2.2vw, 1.4rem)",
          fontWeight: 600,
          lineHeight: 1.15,
          letterSpacing: "-0.02em",
          marginTop: portrait ? "10%" : 0,
        }}
      >
        {title || "Your title"}
      </div>
      <div style={{ display: "grid", alignContent: "center", gap: 10 }}>
        {speakers.map((s, i) => (
          <div key={i} style={{ display: "grid", gap: 4 }}>
            <span style={{ color: s.color, fontSize: "0.8rem", fontWeight: 600 }}>{s.name}</span>
            <Waveform tracks={tracks[i] ? [tracks[i]] : []} height={portrait ? 64 : 56} progress={progress} />
          </div>
        ))}
      </div>
      <div style={{ color: t.muted, fontSize: "0.8rem", fontWeight: 700 }}>oku</div>
    </div>
  );
}
