// Stand-ins for OpenAI-compatible transcription and chat endpoints, for
// development without API keys. Neither understands anything:
// - /audio/transcriptions returns placeholder words spread evenly over the
//   audio it receives, with correct timing;
// - /chat/completions answers the highlights prompt with evenly spaced line
//   ranges in the exact JSON shape the real model is asked for.
// That is enough to exercise the transcript panel, captions and Moments end to end.
//
//   node scripts/mock-ai.mjs            # listens on :4100
//   TRANSCRIPTION_API_KEY=mock TRANSCRIPTION_BASE_URL=http://localhost:4100/v1 \
//   HIGHLIGHTS_API_KEY=mock HIGHLIGHTS_BASE_URL=http://localhost:4100/v1 HIGHLIGHTS_MODEL=mock npm run dev

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

const CATEGORIES = ["funny", "insight", "story", "emotional", "debate", "advice"];

async function chat(req, res) {
  const body = await new Response(req).json();
  const prompt = body.messages.at(-1).content;
  const want = Number(/Pick up to (\d+)/.exec(prompt)?.[1] ?? 3);
  const lines = [...prompt.matchAll(/^L(\d+) \[(\d+):(\d+)\]/gm)].map((m) => ({ n: Number(m[1]), t: Number(m[2]) * 60 + Number(m[3]) }));
  const moments = [];
  const per = Math.max(1, Math.floor(lines.length / want));
  for (let k = 0; k < want && k * per < lines.length; k++) {
    const first = lines[k * per];
    // Extend over following lines until ~20 s have passed (or the block ends).
    let last = first;
    for (let j = k * per; j < Math.min(lines.length, (k + 1) * per); j++) {
      last = lines[j];
      if (lines[j].t - first.t >= 20) break;
    }
    const category = CATEGORIES[k % CATEGORIES.length];
    moments.push({
      start_line: first.n,
      end_line: last.n,
      title: `Mock moment ${k + 1}: the ${category} bit`,
      category,
      why: `Placeholder suggestion from the mock, lines ${first.n} to ${last.n}.`,
      post: `A moment from our conversation. #oku #${category}`,
    });
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ moments }) } }] }));
}

http
  .createServer(async (req, res) => {
    if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
      try {
        await chat(req, res);
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
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
  .listen(PORT, () => console.log(`Mock AI on http://localhost:${PORT}/v1 (audio/transcriptions, chat/completions)`));
