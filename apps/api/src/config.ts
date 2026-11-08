import "dotenv/config";
import path from "node:path";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  webOrigins: (process.env.WEB_ORIGIN ?? "http://localhost:3000").split(",").map((s) => s.trim()),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  databaseUrl: required("DATABASE_URL"),
  storage: {
    driver: (process.env.STORAGE_DRIVER ?? "disk") as "disk" | "s3",
    dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
    s3: {
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? "us-east-1",
      bucket: process.env.S3_BUCKET ?? "oku",
      accessKey: process.env.S3_ACCESS_KEY ?? "",
      secretKey: process.env.S3_SECRET_KEY ?? "",
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    },
  },
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
  fontFile: process.env.FONT_FILE || undefined,
  transcription: {
    apiKey: process.env.TRANSCRIPTION_API_KEY || "",
    baseUrl: process.env.TRANSCRIPTION_BASE_URL || "https://api.openai.com/v1",
    model: process.env.TRANSCRIPTION_MODEL || "whisper-1",
    language: process.env.TRANSCRIPTION_LANGUAGE || undefined,
  },
  highlights: {
    apiKey: process.env.HIGHLIGHTS_API_KEY || "",
    baseUrl: process.env.HIGHLIGHTS_BASE_URL || "https://api.openai.com/v1",
    model: process.env.HIGHLIGHTS_MODEL || "",
  },
  ice: {
    stunUrl: process.env.STUN_URL ?? "stun:stun.l.google.com:19302",
    turnUrl: process.env.TURN_URL || undefined,
    turnUsername: process.env.TURN_USERNAME || undefined,
    turnCredential: process.env.TURN_CREDENTIAL || undefined,
  },
};

export function iceServers(): RTCIceServerLike[] {
  const servers: RTCIceServerLike[] = [{ urls: config.ice.stunUrl }];
  if (config.ice.turnUrl) {
    servers.push({
      urls: config.ice.turnUrl,
      username: config.ice.turnUsername,
      credential: config.ice.turnCredential,
    });
  }
  return servers;
}

export type RTCIceServerLike = { urls: string; username?: string; credential?: string };
