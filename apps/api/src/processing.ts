import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "./db.js";
import { chunks, conversations, exports, participants, tracks } from "./schema.js";
import { storage, keys } from "./storage.js";
import { runFfmpeg, runFfmpegToBuffer, probeDurationMs, findFontFile, escapeFilterText, escapeFilterPath } from "./ffmpeg.js";
import { presetById, THEMES, type Theme } from "./presets.js";

const PEAK_BUCKETS = 1500;
const PEAK_RATE = 8000; // Hz, mono s16le — plenty for a waveform picture

async function withTempDir<T>(label: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `oku-${label}-`));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/**
 * After every participant's recorder has finished uploading:
 * 1. stitch each track's chunks back into one file,
 * 2. transcode each to a clean per-speaker AAC file, padded at the start so all
 *    tracks share the same timeline (t=0 = the earliest recorder start),
 * 3. mix them down,
 * 4. compute waveform peaks per speaker for the Studio timeline.
 */
export async function processConversation(conversationId: string): Promise<void> {
  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    with: { participants: { with: { track: { with: { chunks: { orderBy: asc(chunks.index) } } } } } },
  });
  if (!conversation) return;

  await db.update(conversations).set({ status: "processing", error: null }).where(eq(conversations.id, conversationId));

  try {
    await withTempDir(conversationId, async (dir) => {
      const participants = conversation.participants.filter(
        (p) => p.track && p.track.chunks.length > 0 && p.recorderStartedAt,
      );
      if (participants.length === 0) throw new Error("No audio was uploaded for this conversation.");

      const earliest = Math.min(...participants.map((p) => p.recorderStartedAt!.getTime()));

      const perSpeaker: { participantId: string; color: string; name: string; file: string; durationMs: number }[] = [];

      for (const p of participants) {
        const track = p.track!;
        // 1. Stitch chunks. Chunks from one MediaRecorder session concatenate into a valid stream.
        const raw = path.join(dir, `${track.id}.raw`);
        const out = fs.createWriteStream(raw);
        for (const chunk of track.chunks) {
          const { stream } = await storage.open(chunk.key);
          await new Promise<void>((resolve, reject) => {
            stream.on("end", resolve).on("error", reject).pipe(out, { end: false });
          });
        }
        await new Promise<void>((resolve) => out.end(resolve));

        // 2. Transcode + align. adelay pads the start so this track lines up with the earliest one.
        const offsetMs = Math.max(0, p.recorderStartedAt!.getTime() - earliest);
        const clean = path.join(dir, `${track.id}.m4a`);
        await runFfmpeg([
          "-i", raw,
          "-vn",
          "-af", `adelay=${offsetMs}:all=1,aresample=48000`,
          "-ac", "1",
          "-c:a", "aac", "-b:a", "160k",
          "-movflags", "+faststart",
          clean,
        ]);
        const durationMs = await probeDurationMs(clean);
        await storage.put(keys.track(conversationId, track.id), fs.createReadStream(clean), "audio/mp4");
        await db
          .update(tracks)
          .set({ status: "processed", processedKey: keys.track(conversationId, track.id), durationMs })
          .where(eq(tracks.id, track.id));
        perSpeaker.push({ participantId: p.id, color: p.color, name: p.displayName, file: clean, durationMs });
      }

      // 3. Mix down. normalize=0 keeps each voice at its recorded level instead of dividing by N.
      const mixed = path.join(dir, "mixed.m4a");
      const inputs = perSpeaker.flatMap((s) => ["-i", s.file]);
      const mixFilter =
        perSpeaker.length === 1
          ? "[0:a]anull[out]"
          : `${perSpeaker.map((_, i) => `[${i}:a]`).join("")}amix=inputs=${perSpeaker.length}:normalize=0:dropout_transition=0[out]`;
      await runFfmpeg([
        ...inputs,
        "-filter_complex", mixFilter,
        "-map", "[out]",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        mixed,
      ]);
      const durationMs = Math.max(await probeDurationMs(mixed), ...perSpeaker.map((s) => s.durationMs));
      await storage.put(keys.mixed(conversationId), fs.createReadStream(mixed), "audio/mp4");

      // 4. Peaks for the Studio timeline, one array per speaker on a shared time axis.
      const peakTracks = [];
      for (const s of perSpeaker) {
        peakTracks.push({
          participantId: s.participantId,
          name: s.name,
          color: s.color,
          peaks: await computePeaks(s.file, durationMs),
        });
      }
      const peaks = { durationMs, buckets: PEAK_BUCKETS, tracks: peakTracks };
      await storage.put(keys.peaks(conversationId), Buffer.from(JSON.stringify(peaks)), "application/json");

      await db
        .update(conversations)
        .set({ status: "ready", durationMs, mixedKey: keys.mixed(conversationId), peaksKey: keys.peaks(conversationId) })
        .where(eq(conversations.id, conversationId));
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(conversations).set({ status: "failed", error: message }).where(eq(conversations.id, conversationId));
    throw err;
  }
}

/** Max absolute amplitude per bucket, 0..1, over a fixed total duration so tracks line up. */
async function computePeaks(file: string, totalDurationMs: number): Promise<number[]> {
  const pcm = await runFfmpegToBuffer(["-i", file, "-f", "s16le", "-ac", "1", "-ar", String(PEAK_RATE), "pipe:1"]);
  const totalSamples = Math.max(1, Math.round((totalDurationMs / 1000) * PEAK_RATE));
  const samplesPerBucket = totalSamples / PEAK_BUCKETS;
  const sampleCount = Math.floor(pcm.length / 2);
  const peaks = new Array<number>(PEAK_BUCKETS).fill(0);
  for (let b = 0; b < PEAK_BUCKETS; b++) {
    const start = Math.floor(b * samplesPerBucket);
    const end = Math.min(sampleCount, Math.floor((b + 1) * samplesPerBucket));
    let max = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2));
      if (v > max) max = v;
    }
    peaks[b] = max / 32768;
  }
  // Normalise so the loudest moment reaches the top of the picture.
  const top = Math.max(...peaks, 0.05);
  return peaks.map((p) => Math.round((p / top) * 1000) / 1000);
}

/**
 * Renders a clip: trimmed audio of every speaker, mixed, under an animated
 * waveform where each speaker has their own colour and their own wave.
 */
export async function renderExport(exportId: string): Promise<void> {
  const job = await db.query.exports.findFirst({
    where: eq(exports.id, exportId),
    with: { conversation: { with: { participants: { with: { track: true }, orderBy: desc(participants.isHost) } } } },
  });
  if (!job) return;
  const preset = presetById(job.platform);
  if (!preset) throw new Error(`Unknown platform ${job.platform}`);
  const theme = THEMES[(job.theme as Theme) in THEMES ? (job.theme as Theme) : "night"];

  await db.update(exports).set({ status: "rendering", error: null }).where(eq(exports.id, exportId));

  try {
    await withTempDir(`export-${exportId}`, async (dir) => {
      const speakers = job.conversation.participants.filter((p) => p.track?.processedKey);
      if (speakers.length === 0) throw new Error("This conversation has no processed audio.");

      const files: string[] = [];
      for (const s of speakers) {
        const f = path.join(dir, `${s.id}.m4a`);
        await storage.downloadTo(s.track!.processedKey!, f);
        files.push(f);
      }

      const { width: W, height: H } = preset;
      const startS = (job.startMs / 1000).toFixed(3);
      const endS = (job.endMs / 1000).toFixed(3);
      const fps = 30;

      // Layout: title block at the top (shrunk until it fits in four lines), then one wave
      // band per speaker stacked below it, each with the speaker's name above it.
      const margin = Math.round(W * 0.08);
      const waveWidth = W - margin * 2;
      const nameSize = Math.round(Math.min(W, H) * 0.035);
      const baseTitleSize = Math.round(Math.min(W, H) * 0.07);
      let titleSize = baseTitleSize;
      let titleLines = wrapTitle(job.title, Math.floor(waveWidth / (titleSize * 0.56)));
      while (titleLines.length > 4 && titleSize > baseTitleSize * 0.6) {
        titleSize = Math.round(titleSize * 0.9);
        titleLines = wrapTitle(job.title, Math.floor(waveWidth / (titleSize * 0.56)));
      }
      if (titleLines.length > 4) titleLines = [...titleLines.slice(0, 3), titleLines[3].replace(/\s*\S*$/, "") + "…"];
      const titleTop = Math.round(H * 0.1);
      const titleBlockBottom = titleTop + titleLines.length * Math.round(titleSize * 1.2);

      const bandGap = Math.round(H * 0.03) + nameSize;
      const bandAreaTop = Math.max(titleBlockBottom + Math.round(H * 0.05) + nameSize, Math.round(H * 0.3));
      const bandAreaBottom = H - margin - nameSize - Math.round(H * 0.04);
      const bandHeight = Math.min(
        Math.round(H * 0.18),
        Math.floor((bandAreaBottom - bandAreaTop - bandGap * (speakers.length - 1)) / speakers.length),
      );
      const totalBands = bandHeight * speakers.length + bandGap * (speakers.length - 1);
      const firstBandTop = bandAreaTop + Math.round((bandAreaBottom - bandAreaTop - totalBands) / 2);

      const font = findFontFile();
      const fontOpt = font ? `fontfile='${escapeFilterPath(font)}':` : "";

      // drawtext cannot wrap, so the wrapped title is read from a file (no escaping issues).
      const titleFile = path.join(dir, "title.txt");
      await fsp.writeFile(titleFile, titleLines.join("\n"), "utf8");

      const parts: string[] = [];
      // Inputs: one trimmed audio per speaker.
      const inputArgs = files.flatMap((f) => ["-ss", startS, "-to", endS, "-i", f]);

      parts.push(`color=c=${theme.background}:s=${W}x${H}:r=${fps}[bg]`);
      let last = "bg";
      speakers.forEach((s, i) => {
        const top = firstBandTop + i * (bandHeight + bandGap);
        const mid = top + Math.round(bandHeight / 2);
        parts.push(
          // A faint baseline so a quiet speaker still has a presence.
          `[${last}]drawbox=x=${margin}:y=${mid - 1}:w=${waveWidth}:h=2:color=${s.color}@0.35:t=fill[b${i}]`,
          `[${i}:a]asplit=2[a${i}][w${i}in]`,
          `[w${i}in]showwaves=s=${waveWidth}x${bandHeight}:mode=cline:colors=${s.color}:rate=${fps}:scale=sqrt:draw=full[w${i}]`,
          `[b${i}][w${i}]overlay=x=${margin}:y=${top}:shortest=1[v${i}]`,
        );
        last = `v${i}`;
        const name = escapeFilterText(s.displayName);
        parts.push(
          `[${last}]drawtext=${fontOpt}text='${name}':fontsize=${nameSize}:fontcolor=${s.color}:x=${margin}:y=${top - Math.round(nameSize * 1.4)}[n${i}]`,
        );
        last = `n${i}`;
      });

      parts.push(
        `[${last}]drawtext=${fontOpt}textfile='${escapeFilterPath(titleFile)}':fontsize=${titleSize}:fontcolor=${theme.text}:x=${margin}:y=${titleTop}:line_spacing=${Math.round(titleSize * 0.2)}[t]`,
        `[t]drawtext=${fontOpt}text='oku':fontsize=${nameSize}:fontcolor=${theme.muted}:x=${margin}:y=${H - margin}[vout]`,
      );

      const mix =
        speakers.length === 1
          ? "[a0]anull[aout]"
          : `${speakers.map((_, i) => `[a${i}]`).join("")}amix=inputs=${speakers.length}:normalize=0:dropout_transition=0[aout]`;
      parts.push(mix);

      const out = path.join(dir, "clip.mp4");
      await runFfmpeg([
        ...inputArgs,
        "-filter_complex", parts.join(";"),
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(fps),
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-shortest",
        out,
      ]);

      await storage.put(keys.export(job.conversationId, exportId), fs.createReadStream(out), "video/mp4");
      await db
        .update(exports)
        .set({ status: "ready", outputKey: keys.export(job.conversationId, exportId) })
        .where(eq(exports.id, exportId));
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(exports).set({ status: "failed", error: message }).where(eq(exports.id, exportId));
    throw err;
  }
}

/** Greedy word wrap for the cover title; drawtext draws the newlines as-is. */
function wrapTitle(title: string, maxChars: number): string[] {
  const words = title.trim().split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}
