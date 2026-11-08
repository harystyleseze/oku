export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

/** Thin fetch wrapper: JSON in, JSON out, cookies included, errors as ApiError. */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    ...rest,
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : res.statusText;
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

export function wsUrl(roomSlug: string) {
  const u = new URL(API_URL);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.search = `?room=${encodeURIComponent(roomSlug)}`;
  return u.toString();
}

// ---------- shapes shared with the API ----------

export interface User {
  id: string;
  email: string;
  displayName: string;
}

export interface Room {
  id: string;
  slug: string;
  title: string;
  createdAt: string;
  _count?: { conversations: number };
}

export type ConversationStatus = "recording" | "processing" | "ready" | "failed";

export interface ParticipantSummary {
  id: string;
  displayName: string;
  color: string;
  isHost: boolean;
  track: { id: string; status: string; durationMs: number | null; processedKey: string | null } | null;
}

export interface ExportJob {
  id: string;
  platform: string;
  startMs: number;
  endMs: number;
  title: string;
  theme: string;
  captions: boolean;
  status: "queued" | "rendering" | "ready" | "failed";
  outputKey: string | null;
  error: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  status: ConversationStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  error: string | null;
  transcriptStatus: "none" | "queued" | "running" | "ready" | "failed";
  transcriptError: string | null;
  room: { slug: string; title: string };
  participants: ParticipantSummary[];
  exports: ExportJob[];
}

export interface TranscriptWord {
  w: string;
  s: number;
  e: number;
}

export interface TranscriptSegment {
  participantId: string;
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}

export interface Transcript {
  language: string | null;
  speakers: { participantId: string; name: string; color: string }[];
  segments: TranscriptSegment[];
}

export interface Features {
  transcription: boolean;
}

export interface ConversationListItem {
  id: string;
  title: string;
  status: ConversationStatus;
  startedAt: string;
  durationMs: number | null;
  room: { slug: string; title: string };
  participants: { displayName: string; color: string }[];
}

export interface Preset {
  id: string;
  label: string;
  width: number;
  height: number;
  maxSeconds: number | null;
  recommendedSeconds: number | null;
  note: string;
}

export interface Peaks {
  durationMs: number;
  buckets: number;
  tracks: { participantId: string; name: string; color: string; peaks: number[] }[];
}

export function formatDuration(ms: number | null | undefined) {
  if (ms == null) return "—";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? h + ":" : ""}${mm}:${String(s).padStart(2, "0")}`;
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
