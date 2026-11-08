// A stand-in for an OpenAI-compatible transcription endpoint, for development
// without an API key. It does not understand speech: it returns placeholder
// words spread evenly over the audio it receives, with correct timing, so the
// transcript panel, downloads and burned-in captions can be exercised end to end.
//
//   node scripts/mock-transcriber.mjs            # listens on :4100
//   TRANSCRIPTION_API_KEY=mock TRANSCRIPTION_BASE_URL=http://localhost:4100/v1 npm run dev

import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 4100);
const WORDS = "so I think the real lesson about money is that nobody tells you how it changes your friendships until it already has".split(" ");

function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(parseFloat(out) || 0));
  });
}

http
  .createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.endsWith("/audio/transcriptions")) {
      res.writeHead(404).end();
      return;
    }
    try {
      const form = await new Response(req, { headers: req.headers }).formData();
      const file = form.get("file");
      const tmp = path.join(os.tmpdir(), `mock-${Date.now()}-${Math.random().toString(36).slice(2)}.m4a`);
      await fs.writeFile(tmp, Buffer.from(await file.arrayBuffer()));
      const duration = await probeDuration(tmp);
      await fs.rm(tmp, { force: true });

      const count = Math.max(1, Math.round(duration * 2.4)); // ~2.4 words per second
      const step = duration / count;
      const words = Array.from({ length: count }, (_, i) => ({
        word: WORDS[i % WORDS.length],
        start: +(i * step).toFixed(3),
        end: +((i + 1) * step - 0.03).toFixed(3),
      }));
      const text = words.map((w) => w.word).join(" ");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ task: "transcribe", language: "english", duration, text, words, segments: [{ id: 0, start: 0, end: duration, text }] }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  })
  .listen(PORT, () => console.log(`Mock transcriber on http://localhost:${PORT}/v1/audio/transcriptions`));
