import { spawn } from "node:child_process";
import fs from "node:fs";
import { config } from "./config.js";

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().slice(-2000)}`));
    });
  });
}

/** Runs ffmpeg and returns stdout as a Buffer (used to pull raw PCM for peaks). */
export function runFfmpegToBuffer(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", ...args]);
    const out: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (d) => out.push(d));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().slice(-2000)}`));
    });
  });
}

export function probeDurationMs(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ffprobePath, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      const seconds = parseFloat(out.trim());
      if (code === 0 && Number.isFinite(seconds)) resolve(Math.round(seconds * 1000));
      else reject(new Error(`ffprobe failed: ${err.trim()}`));
    });
  });
}

const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "C:/Windows/Fonts/arialbd.ttf",
];

/** A font file for drawtext. Configured one first, then common system locations. */
export function findFontFile(): string | undefined {
  if (config.fontFile && fs.existsSync(config.fontFile)) return config.fontFile;
  return FONT_CANDIDATES.find((p) => fs.existsSync(p));
}

/** Escapes a string for use inside an ffmpeg filter option value. */
export function escapeFilterText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/;/g, "\\;")
    .replace(/%/g, "\\%");
}

export function escapeFilterPath(p: string): string {
  // Windows drive colons and any single quotes need escaping inside filter graphs.
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
