/**
 * Export targets. One source of truth: the web app fetches this from GET /presets.
 * maxSeconds is the longest clip the platform accepts for the format we target
 * (short-form vertical for TikTok/Reels/Shorts, a square clip for X, full length for YouTube).
 */
export type Platform = "tiktok" | "reels" | "shorts" | "x" | "youtube";

export interface Preset {
  id: Platform;
  label: string;
  width: number;
  height: number;
  maxSeconds: number | null;
  recommendedSeconds: number | null;
  note: string;
}

export const PRESETS: Preset[] = [
  {
    id: "tiktok",
    label: "TikTok",
    width: 1080,
    height: 1920,
    maxSeconds: 600,
    recommendedSeconds: 60,
    note: "Vertical. Up to 10 minutes; under a minute performs best.",
  },
  {
    id: "reels",
    label: "Instagram Reels",
    width: 1080,
    height: 1920,
    maxSeconds: 90,
    recommendedSeconds: 60,
    note: "Vertical. Reels accept up to 90 seconds.",
  },
  {
    id: "shorts",
    label: "YouTube Shorts",
    width: 1080,
    height: 1920,
    maxSeconds: 180,
    recommendedSeconds: 60,
    note: "Vertical. Shorts accept up to 3 minutes.",
  },
  {
    id: "x",
    label: "X",
    width: 1080,
    height: 1080,
    maxSeconds: 140,
    recommendedSeconds: 60,
    note: "Square. Standard accounts can post up to 2 minutes 20 seconds.",
  },
  {
    id: "youtube",
    label: "YouTube",
    width: 1920,
    height: 1080,
    maxSeconds: null,
    recommendedSeconds: null,
    note: "Widescreen. Any length, for the full conversation.",
  },
];

export const THEMES = {
  night: { background: "#0F1017", text: "#FFFFFF", muted: "#9A9DAB" },
  day: { background: "#F3F2ED", text: "#171A2B", muted: "#6D7083" },
} as const;

export type Theme = keyof typeof THEMES;

/** Speaker colours in join order. Chosen to stay distinct on both themes. */
export const SPEAKER_COLORS = ["#FF7A59", "#4C6FFF", "#1FB28A", "#C94DD6", "#F2B134", "#2FB7D9"];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
