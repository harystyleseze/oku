import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { config } from "./config.js";

/**
 * Where recordings and exports live. Two drivers, same four operations:
 * disk (default, good for a single machine) and S3 (any S3-compatible bucket).
 */
export interface Storage {
  put(key: string, body: Buffer | Readable, contentType?: string): Promise<void>;
  /** Streams the object to a local file path. */
  downloadTo(key: string, filePath: string): Promise<void>;
  /** Returns a readable stream plus total object size. Optional byte range (inclusive) for seeking. */
  open(key: string, range?: { start: number; end: number }): Promise<{ stream: Readable; size: number }>;
  deletePrefix(prefix: string): Promise<void>;
}

class DiskStorage implements Storage {
  constructor(private root: string) {}

  private resolve(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root)) throw new Error("Invalid storage key");
    return p;
  }

  async put(key: string, body: Buffer | Readable) {
    const p = this.resolve(key);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    if (Buffer.isBuffer(body)) {
      await fsp.writeFile(p, body);
    } else {
      await new Promise<void>((resolve, reject) => {
        body.pipe(fs.createWriteStream(p)).on("finish", () => resolve()).on("error", reject);
      });
    }
  }

  async downloadTo(key: string, filePath: string) {
    await fsp.copyFile(this.resolve(key), filePath);
  }

  async open(key: string, range?: { start: number; end: number }) {
    const p = this.resolve(key);
    const stat = await fsp.stat(p);
    return { stream: fs.createReadStream(p, range), size: stat.size };
  }

  async deletePrefix(prefix: string) {
    await fsp.rm(this.resolve(prefix), { recursive: true, force: true });
  }
}

class S3Storage implements Storage {
  private client: S3Client;
  private bucket: string;

  constructor() {
    const s = config.storage.s3;
    this.bucket = s.bucket;
    this.client = new S3Client({
      endpoint: s.endpoint,
      region: s.region,
      forcePathStyle: s.forcePathStyle,
      credentials: { accessKeyId: s.accessKey, secretAccessKey: s.secretKey },
    });
  }

  async put(key: string, body: Buffer | Readable, contentType?: string) {
    const buf = Buffer.isBuffer(body) ? body : await streamToBuffer(body);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buf, ContentType: contentType }),
    );
  }

  async downloadTo(key: string, filePath: string) {
    const { stream } = await this.open(key);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      stream.pipe(fs.createWriteStream(filePath)).on("finish", () => resolve()).on("error", reject);
    });
  }

  async open(key: string, range?: { start: number; end: number }) {
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range ? `bytes=${range.start}-${range.end}` : undefined }),
    );
    return { stream: res.Body as Readable, size: Number(head.ContentLength ?? 0) };
  }

  async deletePrefix(prefix: string) {
    let token: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys } }));
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(parts);
}

export const storage: Storage =
  config.storage.driver === "s3" ? new S3Storage() : new DiskStorage(config.storage.dataDir);

/** Storage key layout, in one place so nothing else guesses paths. */
export const keys = {
  conversationPrefix: (conversationId: string) => `conversations/${conversationId}/`,
  chunk: (conversationId: string, trackId: string, index: number) =>
    `conversations/${conversationId}/chunks/${trackId}/${String(index).padStart(6, "0")}`,
  track: (conversationId: string, trackId: string) => `conversations/${conversationId}/tracks/${trackId}.m4a`,
  mixed: (conversationId: string) => `conversations/${conversationId}/mixed.m4a`,
  peaks: (conversationId: string) => `conversations/${conversationId}/peaks.json`,
  transcript: (conversationId: string) => `conversations/${conversationId}/transcript.json`,
  export: (conversationId: string, exportId: string) => `conversations/${conversationId}/exports/${exportId}.mp4`,
};
