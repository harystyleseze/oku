import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db.js";
import { conversations } from "./schema.js";
import { storage, keys } from "./storage.js";
import { runFfmpeg } from "./ffmpeg.js";

/**
 * Transcription. Because every speaker has their own track, each voice is
 * transcribed on its own: speaker labels are exact, no diarisation needed.
 *
 * Whisper-style models invent text when handed long silence, and a speaker's
 * track is mostly silence while the other person talks. So each track is first
 * cut into speech regions (silence detection) and only those are sent.
 *
 * Any OpenAI-compatible /audio/transcriptions endpoint works (OpenAI, Groq, a
 * self-hosted server); see TRANSCRIPTION_* in .env.example.
 */

export interface Word {
  w: string;
  s: number; // ms, on the conversation timeline
  e: number;
}

export interface Segment {
  participantId: string;
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export interface Transcript {
  language: string | null;
  speakers: { participantId: string; name: string; color: string }[];
  segments: Segment[];
}

export function transcriptionEnabled() {
  return !!config.transcription.apiKey;
}

const MAX_REGION_S = 600; // keep every upload comfortably under provider size limits
const PAD_S = 0.25;
const MERGE_GAP_S = 2.0;
const MIN_REGION_S = 0.6;
const CONCURRENCY = 3;

/** Speech regions [start, end] in seconds, from ffmpeg's silencedetect. */
export async function speechRegions(file: string, durationS: number): Promise<[number, number][]> {
  const stderr = await new Promise<string>((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, ["-hide_banner", "-nostats", "-i", file, "-af", "silencedetect=noise=-35dB:d=0.8", "-f", "null", "-"]);
    let err = "";
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", reject);
    proc.on("close", () => resolve(err));
  });
  const silences: [number, number][] = [];
  let open: number | null = null;
  for (const line of stderr.split("\n")) {
    const st = /silence_start: ([\d.]+)/.exec(line);
    const en = /silence_end: ([\d.]+)/.exec(line);
    if (st) open = parseFloat(st[1]);
    if (en && open != null) {
      silences.push([open, parseFloat(en[1])]);
      open = null;
    }
  }
  if (open != null) silences.push([open, durationS]);

  // Invert silences into speech, pad, merge close neighbours, drop blips, cap length.
  const speech: [number, number][] = [];
  let cursor = 0;
  for (const [s, e] of silences) {
    if (s > cursor) speech.push([cursor, s]);
    cursor = e;
  }
  if (cursor < durationS) speech.push([cursor, durationS]);

  const merged: [number, number][] = [];
  for (const [s0, e0] of speech) {
    const s = Math.max(0, s0 - PAD_S);
    const e = Math.min(durationS, e0 + PAD_S);
    const last = merged[merged.length - 1];
    if (last && s - last[1] < MERGE_GAP_S) last[1] = e;
    else merged.push([s, e]);
  }
  const out: [number, number][] = [];
  for (const [s, e] of merged) {
    if (e - s < MIN_REGION_S) continue;
    for (let t = s; t < e; t += MAX_REGION_S) out.push([t, Math.min(e, t + MAX_REGION_S)]);
  }
  return out;
}

interface ProviderWord {
  word: string;
  start: number;
  end: number;
}
interface ProviderResponse {
  text?: string;
  language?: string;
  words?: ProviderWord[];
  segments?: { start: number; end: number; text: string }[];
}

async function transcribeFile(file: string): Promise<ProviderResponse> {
  const { baseUrl, apiKey, model, language } = config.transcription;
  const form = new FormData();
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  if (language) form.append("language", language);
  form.append("file", new Blob([await fsp.readFile(file)], { type: "audio/mp4" }), path.basename(file));

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`Transcription service responded ${res.status}`);
      if (!res.ok) throw new FatalError(`Transcription service responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return (await res.json()) as ProviderResponse;
    } catch (err) {
      if (err instanceof FatalError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
  throw lastError ?? new Error("Transcription failed");
}

class FatalError extends Error {}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

/** Words for one speaker's whole track, on the conversation timeline (ms). */
async function transcribeTrack(file: string, durationMs: number, dir: string): Promise<{ words: Word[]; language: string | null }> {
  const regions = await speechRegions(file, durationMs / 1000);
  let language: string | null = null;
  const perRegion = await mapLimit(regions, CONCURRENCY, async ([s, e], i) => {
    const piece = path.join(dir, `${path.basename(file, ".m4a")}-${i}.m4a`);
    await runFfmpeg(["-ss", s.toFixed(3), "-t", (e - s).toFixed(3), "-i", file, "-c:a", "aac", "-b:a", "96k", piece]);
    const r = await transcribeFile(piece);
    await fsp.rm(piece, { force: true });
    if (r.language && !language) language = r.language;
    const words: Word[] =
      r.words && r.words.length
        ? r.words.map((w) => ({ w: w.word.trim(), s: Math.round((s + w.start) * 1000), e: Math.round((s + w.end) * 1000) }))
        : // Providers without word timing: spread each segment's words evenly across the segment.
          (r.segments ?? []).flatMap((seg) => {
            const ws = seg.text.trim().split(/\s+/).filter(Boolean);
            const step = (seg.end - seg.start) / Math.max(1, ws.length);
            return ws.map((w, k) => ({
              w,
              s: Math.round((s + seg.start + k * step) * 1000),
              e: Math.round((s + seg.start + (k + 1) * step) * 1000),
            }));
          });
    return words.filter((w) => w.w.length > 0);
  });
  return { words: perRegion.flat().sort((a, b) => a.s - b.s), language };
}

/** Break one speaker's words into readable segments at pauses. */
function segmentWords(participantId: string, words: Word[]): Segment[] {
  const segments: Segment[] = [];
  let current: Word[] = [];
  const flush = () => {
    if (!current.length) return;
    segments.push({
      participantId,
      start: current[0].s,
      end: current[current.length - 1].e,
      text: current.map((w) => w.w).join(" "),
      words: current,
    });
    current = [];
  };
  for (const w of words) {
    const prev = current[current.length - 1];
    if (prev && (w.s - prev.e > 1000 || current.length >= 40 || /[.!?]$/.test(prev.w) && current.length >= 12)) flush();
    current.push(w);
  }
  flush();
  return segments;
}

export async function transcribeConversation(conversationId: string): Promise<void> {
  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    with: { participants: { with: { track: true } } },
  });
  if (!conversation) return;
  if (!transcriptionEnabled()) {
    await db.update(conversations).set({ transcriptStatus: "failed", transcriptError: "Transcription is not configured on the server." }).where(eq(conversations.id, conversationId));
    return;
  }
  await db.update(conversations).set({ transcriptStatus: "running", transcriptError: null }).where(eq(conversations.id, conversationId));

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "oku-transcribe-"));
  try {
    const speakers = conversation.participants.filter((p) => p.track?.processedKey);
    const transcript: Transcript = {
      language: null,
      speakers: speakers.map((p) => ({ participantId: p.id, name: p.displayName, color: p.color })),
      segments: [],
    };
    for (const p of speakers) {
      const file = path.join(dir, `${p.id}.m4a`);
      await storage.downloadTo(p.track!.processedKey!, file);
      const { words, language } = await transcribeTrack(file, p.track!.durationMs ?? conversation.durationMs ?? 0, dir);
      if (language && !transcript.language) transcript.language = language;
      transcript.segments.push(...segmentWords(p.id, words));
    }
    transcript.segments.sort((a, b) => a.start - b.start);
    const key = keys.transcript(conversationId);
    await storage.put(key, Buffer.from(JSON.stringify(transcript)), "application/json");
    await db.update(conversations).set({ transcriptStatus: "ready", transcriptKey: key }).where(eq(conversations.id, conversationId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(conversations).set({ transcriptStatus: "failed", transcriptError: message }).where(eq(conversations.id, conversationId));
    throw err;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

export async function loadTranscript(key: string): Promise<Transcript> {
  const { stream } = await storage.open(key);
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as Transcript;
}

// ---------- text formats ----------

export function transcriptToText(t: Transcript): string {
  const name = (id: string) => t.speakers.find((s) => s.participantId === id)?.name ?? "Speaker";
  return t.segments.map((s) => `[${fmtClock(s.start)}] ${name(s.participantId)}: ${s.text}`).join("\n");
}

export function transcriptToSrt(t: Transcript): string {
  const name = (id: string) => t.speakers.find((s) => s.participantId === id)?.name ?? "Speaker";
  return t.segments
    .map((s, i) => `${i + 1}\n${fmtSrt(s.start)} --> ${fmtSrt(s.end)}\n${name(s.participantId)}: ${s.text}\n`)
    .join("\n");
}

function fmtClock(ms: number) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h ? h + ":" : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtSrt(ms: number) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(f).padStart(3, "0")}`;
}

// ---------- captions for exports (ASS, burned in with libass) ----------

export interface CaptionStyle {
  width: number;
  height: number;
  fontSize: number;
  /** Distance from the bottom edge to the caption baseline area. */
  marginBottom: number;
  marginSide: number;
  textColor: string;
  fontFile?: string;
}

const MAX_WORDS_PER_CAPTION = 4;
const MAX_CAPTION_MS = 2200;
const CAPTION_GAP_MS = 700;

/**
 * Builds an .ass file for the clip window. Captions are short (a few words),
 * timed to the words, and coloured by speaker.
 */
export function buildCaptionsAss(t: Transcript, startMs: number, endMs: number, style: CaptionStyle): string {
  const speakerIndex = new Map(t.speakers.map((s, i) => [s.participantId, i]));
  const family = fontFamilyName(style.fontFile);
  const styles = t.speakers
    .map(
      (s, i) =>
        `Style: S${i},${family},${style.fontSize},${assColor(s.color)},${assColor(s.color)},&H99000000,&H66000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(style.fontSize * 0.06))},0,2,${style.marginSide},${style.marginSide},${style.marginBottom},1`,
    )
    .join("\n");

  // Words inside the window, grouped into short captions per speaker turn.
  type Cap = { speaker: number; s: number; e: number; words: string[] };
  const caps: Cap[] = [];
  for (const seg of t.segments) {
    const idx = speakerIndex.get(seg.participantId) ?? 0;
    let cur: Cap | null = null;
    for (const w of seg.words) {
      if (w.e <= startMs || w.s >= endMs) continue;
      const s = Math.max(w.s, startMs) - startMs;
      const e = Math.min(w.e, endMs) - startMs;
      if (!cur || cur.words.length >= MAX_WORDS_PER_CAPTION || e - cur.s > MAX_CAPTION_MS || s - cur.e > CAPTION_GAP_MS) {
        cur = { speaker: idx, s, e, words: [] };
        caps.push(cur);
      }
      cur.words.push(w.w);
      cur.e = e;
    }
  }
  caps.sort((a, b) => a.s - b.s);
  // Keep each caption on screen until the next one from anyone, up to a short hold.
  const events = caps.map((c, i) => {
    const next = caps[i + 1];
    const end = Math.min(next ? next.s : c.e + 900, c.e + 900);
    return `Dialogue: 0,${assTime(c.s)},${assTime(Math.max(end, c.s + 300))},S${c.speaker},,0,0,0,,${c.words.join(" ").replace(/[{}]/g, "")}`;
  });

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${style.width}`,
    `PlayResY: ${style.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

/** libass matches fonts by family name, not file name. */
function fontFamilyName(fontFile?: string) {
  const base = fontFile ? path.basename(fontFile).toLowerCase() : "";
  if (base.includes("dejavu")) return "DejaVu Sans";
  if (base.includes("inter")) return "Inter";
  if (base.includes("arial")) return "Arial";
  if (base.includes("helvetica")) return "Helvetica";
  return "Sans";
}

function assColor(hex: string) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "&H00FFFFFF";
  return `&H00${m[3]}${m[2]}${m[1]}`.toUpperCase();
}

function assTime(ms: number) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function fileExists(p: string) {
  return fs.existsSync(p);
}
