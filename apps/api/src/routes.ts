import { Router, raw } from "express";
import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db.js";
import { chunks, conversations, exports, participants, rooms, tracks, users } from "./schema.js";
import { createSession, destroySession, requireUser } from "./auth.js";
import { storage, keys } from "./storage.js";
import { PRESETS, THEMES, presetById } from "./presets.js";
import { processIfReady } from "./signaling.js";
import { enqueue } from "./queue.js";
import { loadTranscript, transcriptToSrt, transcriptToText, transcriptionEnabled } from "./transcription.js";
import { highlightsEnabled } from "./highlights.js";

export const router = Router();

const MAX_CHUNK_BYTES = 25 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(res: Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

function parse<T>(schema: z.ZodType<T>, body: unknown, res: Response): T | undefined {
  const r = schema.safeParse(body);
  if (!r.success) {
    fail(res, 400, r.error.issues.map((i) => i.message).join(" "));
    return undefined;
  }
  return r.data;
}

// ---------- Auth ----------

const credentials = z.object({
  email: z.string().email("Enter a valid email address.").transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8, "Use at least 8 characters for your password."),
});

router.post("/auth/signup", async (req, res) => {
  const body = parse(credentials.extend({ displayName: z.string().trim().min(1, "Tell us your name.").max(40) }), req.body, res);
  if (!body) return;
  const existing = await db.query.users.findFirst({ where: eq(users.email, body.email) });
  if (existing) return fail(res, 409, "An account with this email already exists. Sign in instead.");
  const [user] = await db
    .insert(users)
    .values({ email: body.email, passwordHash: await bcrypt.hash(body.password, 10), displayName: body.displayName })
    .returning();
  await createSession(res, user.id);
  res.status(201).json({ user: publicUser(user) });
});

router.post("/auth/login", async (req, res) => {
  const body = parse(credentials, req.body, res);
  if (!body) return;
  const user = await db.query.users.findFirst({ where: eq(users.email, body.email) });
  if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
    return fail(res, 401, "Email or password is incorrect.");
  }
  await createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.post("/auth/logout", async (req, res) => {
  await destroySession(req, res);
  res.status(204).end();
});

router.get("/auth/me", (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

function publicUser(u: { id: string; email: string; displayName: string }) {
  return { id: u.id, email: u.email, displayName: u.displayName };
}

// ---------- Presets ----------

router.get("/presets", (_req, res) => {
  res.json({ presets: PRESETS, themes: THEMES, features: { transcription: transcriptionEnabled(), highlights: transcriptionEnabled() && highlightsEnabled() } });
});

// ---------- Rooms ----------

router.post("/rooms", requireUser, async (req, res) => {
  const body = parse(z.object({ title: z.string().trim().min(1, "Give the room a name.").max(80) }), req.body, res);
  if (!body) return;
  const [room] = await db.insert(rooms).values({ title: body.title, hostId: req.user!.id, slug: newSlug() }).returning();
  res.status(201).json({ room });
});

router.get("/rooms", requireUser, async (req, res) => {
  const list = await db
    .select({
      id: rooms.id,
      slug: rooms.slug,
      title: rooms.title,
      createdAt: rooms.createdAt,
      conversationCount: count(conversations.id),
    })
    .from(rooms)
    .leftJoin(conversations, eq(conversations.roomId, rooms.id))
    .where(eq(rooms.hostId, req.user!.id))
    .groupBy(rooms.id)
    .orderBy(desc(rooms.createdAt));
  res.json({ rooms: list.map((r) => ({ ...r, _count: { conversations: Number(r.conversationCount) } })) });
});

// Public: what a guest sees before joining.
router.get("/rooms/:slug", async (req, res) => {
  const room = await db.query.rooms.findFirst({
    where: eq(rooms.slug, req.params.slug),
    with: { host: { columns: { displayName: true } } },
  });
  if (!room) return fail(res, 404, "This room link is not valid.");
  res.json({
    room: { slug: room.slug, title: room.title, hostName: room.host.displayName, isHost: req.user?.id === room.hostId },
  });
});

router.delete("/rooms/:slug", requireUser, async (req, res) => {
  const room = await db.query.rooms.findFirst({ where: eq(rooms.slug, req.params.slug), with: { conversations: true } });
  if (!room || room.hostId !== req.user!.id) return fail(res, 404, "Room not found.");
  for (const c of room.conversations) await storage.deletePrefix(keys.conversationPrefix(c.id));
  await db.delete(rooms).where(eq(rooms.id, room.id));
  res.status(204).end();
});

function newSlug() {
  // 10 url-safe characters: unguessable enough for an invite link, short enough to read aloud.
  return randomBytes(8).toString("base64url").slice(0, 10).toLowerCase();
}

// ---------- Recording uploads (guests authenticate with the track's upload token) ----------

async function trackForUpload(req: Request, res: Response) {
  const token = req.header("x-upload-token");
  if (!UUID.test(req.params.trackId) || !token || !UUID.test(token)) {
    fail(res, 403, "This upload link is not valid.");
    return null;
  }
  const track = await db.query.tracks.findFirst({
    where: eq(tracks.id, req.params.trackId),
    with: { participant: { columns: { conversationId: true } } },
  });
  if (!track || track.uploadToken !== token) {
    fail(res, 403, "This upload link is not valid.");
    return null;
  }
  if (track.status !== "uploading") {
    fail(res, 409, "This recording has already been finalised.");
    return null;
  }
  return track;
}

router.put(
  "/tracks/:trackId/chunks/:index",
  raw({ type: () => true, limit: MAX_CHUNK_BYTES }),
  async (req, res) => {
    const track = await trackForUpload(req, res);
    if (!track) return;
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) return fail(res, 400, "Bad chunk index.");
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) return fail(res, 400, "Empty chunk.");

    const key = keys.chunk(track.participant.conversationId, track.id, index);
    await storage.put(key, body, "application/octet-stream");
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(chunks)
        .values({ trackId: track.id, index, key, bytes: body.length })
        .onConflictDoUpdate({ target: [chunks.trackId, chunks.index], set: { bytes: body.length } })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      if (inserted[0]?.inserted) {
        await tx
          .update(tracks)
          .set({ chunkCount: sql`${tracks.chunkCount} + 1`, bytes: sql`${tracks.bytes} + ${body.length}` })
          .where(eq(tracks.id, track.id));
      }
    });
    res.json({ ok: true, index });
  },
);

// Tells the server how many chunks to expect, so it can ask for any that went missing.
router.post("/tracks/:trackId/finalize", async (req, res) => {
  const track = await trackForUpload(req, res);
  if (!track) return;
  const body = parse(z.object({ expectedChunks: z.number().int().min(0) }), req.body, res);
  if (!body) return;

  const have = await db.select({ index: chunks.index }).from(chunks).where(eq(chunks.trackId, track.id));
  const haveSet = new Set(have.map((c) => c.index));
  const missing: number[] = [];
  for (let i = 0; i < body.expectedChunks; i++) if (!haveSet.has(i)) missing.push(i);
  if (missing.length) return res.status(409).json({ error: "Some chunks are missing.", missing });

  await db.update(tracks).set({ status: "finalized", expectedChunks: body.expectedChunks }).where(eq(tracks.id, track.id));
  await processIfReady(track.participant.conversationId);
  res.json({ ok: true });
});

// ---------- Conversations (host only) ----------

const conversationWith = {
  room: { columns: { slug: true, title: true, hostId: true } },
  participants: {
    orderBy: desc(participants.isHost),
    columns: { id: true, displayName: true, color: true, isHost: true },
    with: { track: { columns: { id: true, status: true, durationMs: true, processedKey: true } } },
  },
  exports: { orderBy: desc(exports.createdAt) },
} as const;

async function ownedConversation(req: Request, res: Response) {
  const c = UUID.test(req.params.id)
    ? await db.query.conversations.findFirst({ where: eq(conversations.id, req.params.id), with: conversationWith })
    : undefined;
  if (!c || c.room.hostId !== req.user!.id) {
    fail(res, 404, "Conversation not found.");
    return null;
  }
  return c;
}

router.get("/conversations", requireUser, async (req, res) => {
  const mine = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.hostId, req.user!.id));
  const roomIds = mine.map((r) => r.id);
  if (roomIds.length === 0) return res.json({ conversations: [] });
  const list = await db.query.conversations.findMany({
    where: inArray(conversations.roomId, roomIds),
    orderBy: desc(conversations.startedAt),
    columns: { id: true, title: true, status: true, startedAt: true, durationMs: true },
    with: {
      room: { columns: { slug: true, title: true } },
      participants: { columns: { displayName: true, color: true }, orderBy: desc(participants.isHost) },
    },
  });
  res.json({ conversations: list });
});

router.get("/conversations/:id", requireUser, async (req, res) => {
  const c = await ownedConversation(req, res);
  if (!c) return;
  res.json({ conversation: c });
});

router.patch("/conversations/:id", requireUser, async (req, res) => {
  const c = await ownedConversation(req, res);
  if (!c) return;
  const body = parse(z.object({ title: z.string().trim().min(1).max(120) }), req.body, res);
  if (!body) return;
  await db.update(conversations).set({ title: body.title }).where(eq(conversations.id, c.id));
  const updated = await db.query.conversations.findFirst({ where: eq(conversations.id, c.id), with: conversationWith });
  res.json({ conversation: updated });
});

router.delete("/conversations/:id", requireUser, async (req, res) => {
  const c = await ownedConversation(req, res);
  if (!c) return;
  await storage.deletePrefix(keys.conversationPrefix(c.id));
  await db.delete(conversations).where(eq(conversations.id, c.id));
  res.status(204).end();
});

router.get("/conversations/:id/peaks", requireUser, async (req, res) => {
  const c = await ownedConversation(req, res);
  if (!c) return;
  if (!c.peaksKey) return fail(res, 404, "Not processed yet.");
  await streamObject(req, res, c.peaksKey, "application/json");
});

// ---------- Transcript ----------

router.get("/conversations/:id/transcript", requireUser, async (req, res) => {
  const c = await ownedConversation(req, res);
  if (!c) return;
  if (!c.transcriptKey) return fail(res, 404, "No transcript yet.");
  await streamObject(req, res, c.transcriptKey, "application/json");
});

router.get("/conversations/:id/transcript.:format(txt|srt)", requireUser, async (req, res) => {
  const c = await ownedConversation(req, res);
  if (!c) return;
  if (!c.transcriptKey) return fail(res, 404, "No transcript yet.");
  const t = await loadTranscript(c.transcriptKey);
  const srt = req.params.format === "srt";
  res.setHeader("Content-Type", srt ? "application/x-subrip; charset=utf-8" : "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName(c.title)}.${req.params.format}"`);
  res.send(srt ? transcriptToSrt(t) : transcriptToText(t));
});

// Start (or retry) transcription for a conversation.
router.post("/conversations/:id/transcribe", requireUser, async (req, res) => {
  const c = await ownedConversation(req, res);
  if (!c) return;
  if (!transcriptionEnabled()) return fail(res, 409, "Transcription is not set up on this server.");
  if (c.status !== "ready") return fail(res, 409, "The conversation is still processing.");
  if (c.transcriptStatus === "queued" || c.transcriptStatus === "running") return res.json({ ok: true });
  await db.update(conversations).set({ transcriptStatus: "queued", transcriptError: null }).where(eq(conversations.id, c.id));
  enqueue({ kind: "transcribe", conversationId: c.id });
  res.json({ ok: true });
});

// Ask the AI producer to (re)read the transcript and suggest moments.
router.post("/conversations/:id/highlights", requireUser, async (req, res) => {
  const c = await ownedConversation(req, res);
  if (!c) return;
  if (!highlightsEnabled()) return fail(res, 409, "Highlights are not set up on this server.");
  if (c.transcriptStatus !== "ready") return fail(res, 409, "The transcript isn't ready yet.");
  if (c.highlightsStatus === "queued" || c.highlightsStatus === "running") return res.json({ ok: true });
  await db.update(conversations).set({ highlightsStatus: "queued", highlightsError: null }).where(eq(conversations.id, c.id));
  enqueue({ kind: "highlights", conversationId: c.id });
  res.json({ ok: true });
});

// Mixed audio, or one speaker's track: /media/mixed or /media/<participantId>
router.get("/conversations/:id/media/:which", requireUser, async (req, res) => {
  const c = await ownedConversation(req, res);
  if (!c) return;
  let key: string | null | undefined;
  let filename: string;
  if (req.params.which === "mixed") {
    key = c.mixedKey;
    filename = `${safeName(c.title)}.m4a`;
  } else {
    const p = c.participants.find((p) => p.id === req.params.which);
    key = p?.track?.processedKey;
    filename = `${safeName(c.title)} - ${safeName(p?.displayName ?? "speaker")}.m4a`;
  }
  if (!key) return fail(res, 404, "Audio not available.");
  if (req.query.download === "1") res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  await streamObject(req, res, key, "audio/mp4");
});

// ---------- Exports ----------

router.post("/conversations/:id/exports", requireUser, async (req, res) => {
  const c = await ownedConversation(req, res);
  if (!c) return;
  if (c.status !== "ready" || !c.durationMs) return fail(res, 409, "This conversation is still processing.");
  const body = parse(
    z.object({
      platform: z.string(),
      startMs: z.number().int().min(0),
      endMs: z.number().int().min(0),
      title: z.string().trim().min(1, "Give the clip a title.").max(120),
      theme: z.enum(["night", "day"]).default("night"),
      captions: z.boolean().default(false),
    }),
    req.body,
    res,
  );
  if (!body) return;
  const preset = presetById(body.platform);
  if (!preset) return fail(res, 400, "Unknown platform.");
  const endMs = Math.min(body.endMs, c.durationMs);
  if (endMs - body.startMs < 1000) return fail(res, 400, "A clip needs to be at least one second long.");
  if (preset.maxSeconds && endMs - body.startMs > preset.maxSeconds * 1000) {
    return fail(res, 400, `${preset.label} clips can be at most ${preset.maxSeconds} seconds.`);
  }
  const [job] = await db
    .insert(exports)
    .values({
      conversationId: c.id,
      platform: preset.id,
      startMs: body.startMs,
      endMs,
      title: body.title,
      theme: body.theme,
      captions: body.captions && c.transcriptStatus === "ready",
    })
    .returning();
  enqueue({ kind: "export", exportId: job.id });
  res.status(201).json({ export: job });
});

router.get("/exports/:id", requireUser, async (req, res) => {
  const job = await ownedExport(req, res);
  if (!job) return;
  res.json({ export: job });
});

router.delete("/exports/:id", requireUser, async (req, res) => {
  const job = await ownedExport(req, res);
  if (!job) return;
  if (job.outputKey) await storage.deletePrefix(job.outputKey);
  await db.delete(exports).where(eq(exports.id, job.id));
  res.status(204).end();
});

router.get("/exports/:id/download", requireUser, async (req, res) => {
  const job = await ownedExport(req, res);
  if (!job) return;
  if (!job.outputKey) return fail(res, 404, "This clip is not ready yet.");
  const preset = presetById(job.platform);
  res.setHeader("Content-Disposition", `attachment; filename="${safeName(job.title)} - ${preset?.label ?? job.platform}.mp4"`);
  await streamObject(req, res, job.outputKey, "video/mp4");
});

async function ownedExport(req: Request, res: Response) {
  const job = UUID.test(req.params.id)
    ? await db.query.exports.findFirst({
        where: eq(exports.id, req.params.id),
        with: { conversation: { columns: {}, with: { room: { columns: { hostId: true } } } } },
      })
    : undefined;
  if (!job || job.conversation.room.hostId !== req.user!.id) {
    fail(res, 404, "Clip not found.");
    return null;
  }
  return job;
}

// ---------- helpers ----------

function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|\n\r]+/g, " ").trim().slice(0, 80) || "oku";
}

/** Streams a stored object with HTTP range support so <audio> and <video> can seek. */
async function streamObject(req: Request, res: Response, key: string, contentType: string) {
  const { stream: probe, size } = await storage.open(key);
  probe.destroy();
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType);
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (m && size > 0) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
      return;
    }
    const { stream } = await storage.open(key, { start, end });
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", end - start + 1);
    stream.pipe(res);
    return;
  }
  const { stream } = await storage.open(key);
  res.setHeader("Content-Length", size);
  stream.pipe(res);
}

