import { eq } from "drizzle-orm";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./db.js";
import { conversations, type Highlight } from "./schema.js";
import { loadTranscript, type Segment, type Transcript } from "./transcription.js";

/**
 * The AI producer: reads the transcript and proposes the moments worth clipping.
 *
 * The model never writes timestamps. It sees the transcript as numbered lines
 * and answers with line numbers; times come from the transcript itself, so a
 * clip always starts at the beginning of a sentence and ends at the end of one.
 *
 * Any OpenAI-compatible /chat/completions endpoint works (see HIGHLIGHTS_* in .env.example).
 */

export function highlightsEnabled() {
  return !!(config.highlights.apiKey && config.highlights.model);
}

const MIN_CLIP_MS = 8_000;
const MAX_CLIP_MS = 90_000; // fits every short-form preset, including Reels
const WINDOW_CHARS = 40_000; // ~10k tokens of transcript per request
const WINDOW_OVERLAP_LINES = 12;

const CATEGORIES = ["funny", "emotional", "insight", "story", "debate", "advice"] as const;

const SYSTEM_PROMPT = `You are the producer of a conversation between real people. You read the transcript and pick the moments that would make great short clips on TikTok, Instagram Reels and YouTube Shorts.

A great moment:
- makes sense on its own to a stranger who has not heard the rest of the conversation;
- starts where a thought starts (never mid-sentence, never with "and so" or "yeah, that's why" that depends on what came before);
- ends where the thought lands: the punchline, the realisation, the answer, the end of the story;
- has energy: laughter, a strong opinion, a turn in a story, a clear piece of advice, an honest or emotional admission, a real disagreement;
- usually runs 20 to 75 seconds.

Avoid greetings, logistics ("can you hear me?"), and anything that only works with context.

Each line of the transcript is "L<number> [mm:ss] Name: text". Answer with line numbers only, never with times.

Return JSON exactly in this shape:
{"moments":[{"start_line":12,"end_line":19,"title":"...","category":"funny|emotional|insight|story|debate|advice","why":"...","post":"..."}]}

- title: a short, specific hook a viewer would click, under 60 characters, in the language of the conversation. No clickbait words like "SHOCKING", no emoji.
- why: one sentence telling the host what happens in the moment.
- post: a ready-to-paste social caption, one or two sentences in the speakers' voice, followed by at most three relevant hashtags.
- Moments must not overlap. Order them from strongest to weakest.`;

const momentSchema = z.object({
  start_line: z.coerce.number().int().min(0),
  end_line: z.coerce.number().int().min(0),
  title: z.string().trim().min(1).max(120),
  category: z.string().trim().toLowerCase(),
  why: z.string().trim().max(400).default(""),
  post: z.string().trim().max(600).default(""),
});
type RawMoment = z.infer<typeof momentSchema>;

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function linesFor(t: Transcript, from: number, to: number) {
  const name = new Map(t.speakers.map((s) => [s.participantId, s.name]));
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    const seg = t.segments[i];
    out.push(`L${i} [${clock(seg.start)}] ${name.get(seg.participantId) ?? "Speaker"}: ${seg.text}`);
  }
  return out.join("\n");
}

/** Splits long transcripts into overlapping windows of numbered lines. */
function windows(t: Transcript): [number, number][] {
  const result: [number, number][] = [];
  let start = 0;
  while (start < t.segments.length) {
    let chars = 0;
    let end = start;
    while (end < t.segments.length && (chars < WINDOW_CHARS || end === start)) {
      chars += t.segments[end].text.length + 24;
      end++;
    }
    result.push([start, end]);
    if (end >= t.segments.length) break;
    start = Math.max(start + 1, end - WINDOW_OVERLAP_LINES);
  }
  return result;
}

async function chat(system: string, user: string): Promise<string> {
  const { baseUrl, apiKey, model } = config.highlights;
  let jsonMode = true;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    }).catch((err: unknown) => err as Error);

    if (res instanceof Error) {
      lastError = new Error(`Could not reach the highlights service at ${baseUrl}.`);
    } else if (res.ok) {
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return body.choices?.[0]?.message?.content ?? "";
    } else {
      const text = await res.text();
      // Some models reject JSON mode; the prompt already asks for JSON, so try once without it.
      if (res.status === 400 && jsonMode && /response_format|json/i.test(text)) {
        jsonMode = false;
        continue;
      }
      if (res.status !== 429 && res.status < 500) throw new Error(`Highlights service responded ${res.status}: ${text.slice(0, 300)}`);
      lastError = new Error(`Highlights service responded ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
  throw lastError ?? new Error("Highlights request failed");
}

function parseMoments(content: string): RawMoment[] {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let data: unknown;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const list = (data as { moments?: unknown }).moments;
  if (!Array.isArray(list)) return [];
  return list.flatMap((m) => {
    const r = momentSchema.safeParse(m);
    return r.success ? [r.data] : [];
  });
}

/** Turns a line range into clip times, keeping it within MIN/MAX at sentence or word boundaries. */
export function toHighlight(raw: RawMoment, segs: Segment[], durationMs: number): Highlight | null {
  let a = Math.min(raw.start_line, raw.end_line);
  let b = Math.max(raw.start_line, raw.end_line);
  if (a >= segs.length) return null;
  b = Math.min(b, segs.length - 1);

  const startMs = segs[a].start;
  const endOf = (i: number, j: number) => Math.max(...segs.slice(i, j + 1).map((s) => s.end));
  while (b > a && endOf(a, b) - startMs > MAX_CLIP_MS) b--;
  let endMs = endOf(a, b);
  if (endMs - startMs > MAX_CLIP_MS) {
    // One very long line: cut at the last word that fits.
    const words = segs.slice(a, b + 1).flatMap((s) => s.words).filter((w) => w.e - startMs <= MAX_CLIP_MS);
    endMs = words.length ? Math.max(...words.map((w) => w.e)) : startMs + MAX_CLIP_MS;
  }
  if (endMs - startMs < MIN_CLIP_MS) return null;

  const category = (CATEGORIES as readonly string[]).includes(raw.category) ? (raw.category as Highlight["category"]) : "insight";
  // A little air on both sides, without breaking the length cap.
  const paddedStart = Math.max(0, startMs - 150);
  return {
    startMs: paddedStart,
    endMs: Math.min(durationMs, endMs + 300, paddedStart + MAX_CLIP_MS),
    title: raw.title.slice(0, 80),
    category,
    why: raw.why,
    post: raw.post,
  };
}

function targetCount(durationMs: number) {
  const minutes = durationMs / 60_000;
  if (minutes < 3) return Math.max(1, Math.round(minutes));
  return Math.min(10, Math.max(3, Math.round(minutes / 4)));
}

export async function findHighlights(conversationId: string): Promise<void> {
  const conversation = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) });
  if (!conversation) return;
  const fail = (message: string) =>
    db.update(conversations).set({ highlightsStatus: "failed", highlightsError: message }).where(eq(conversations.id, conversationId));
  if (!highlightsEnabled()) return void (await fail("Highlights are not configured on the server."));
  if (!conversation.transcriptKey) return void (await fail("The conversation needs a transcript first."));

  await db.update(conversations).set({ highlightsStatus: "running", highlightsError: null }).where(eq(conversations.id, conversationId));
  try {
    const t = await loadTranscript(conversation.transcriptKey);
    const durationMs = conversation.durationMs ?? 0;
    const found: Highlight[] = [];

    if (t.segments.length > 0) {
      const wins = windows(t);
      const total = targetCount(durationMs);
      // Split the target across windows by size so the shares add up to exactly `total`.
      const sizes = wins.map(([from, to]) => to - from);
      const sum = sizes.reduce((a, b) => a + b, 0);
      let cumulative = 0;
      const shares = sizes.map((size) => {
        const before = Math.round((total * cumulative) / sum);
        cumulative += size;
        return Math.round((total * cumulative) / sum) - before;
      });
      for (const [w, [from, to]] of wins.entries()) {
        const share = shares[w];
        if (share < 1) continue;
        const prompt = `Pick up to ${share} moment${share === 1 ? "" : "s"}.\n\nTranscript:\n${linesFor(t, from, to)}`;
        const raws = parseMoments(await chat(SYSTEM_PROMPT, prompt)).filter((m) => m.start_line >= from && m.start_line < to);
        for (const raw of raws) {
          const h = toHighlight(raw, t.segments, durationMs);
          if (!h) continue;
          // Earlier (stronger) picks win when two moments overlap.
          if (found.some((f) => h.startMs < f.endMs && f.startMs < h.endMs)) continue;
          found.push(h);
        }
      }
    }

    found.sort((x, y) => x.startMs - y.startMs);
    await db.update(conversations).set({ highlightsStatus: "ready", highlights: found }).where(eq(conversations.id, conversationId));
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
    throw err;
  }
}
