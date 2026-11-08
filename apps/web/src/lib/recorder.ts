import { API_URL } from "./api";
import { chunkStore } from "./chunkStore";

const TIMESLICE_MS = 5000;

export type UploadState = "idle" | "recording" | "uploading" | "done" | "stuck";

export interface RecorderProgress {
  state: UploadState;
  produced: number;
  uploaded: number;
  /** Set when uploads keep failing; recording continues locally. */
  warning: string | null;
}

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", ""];

export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return MIME_CANDIDATES.find((m) => m === "" || MediaRecorder.isTypeSupported(m)) ?? "";
}

async function uploadChunk(trackId: string, uploadToken: string, index: number, blob: Blob) {
  const res = await fetch(`${API_URL}/tracks/${trackId}/chunks/${index}`, {
    method: "PUT",
    headers: { "x-upload-token": uploadToken, "Content-Type": "application/octet-stream" },
    body: blob,
  });
  if (res.status === 403 || res.status === 404 || res.status === 409) throw new FatalUploadError(res.status);
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
}

/** The server will never accept this chunk (track gone or already finalised): stop retrying. */
class FatalUploadError extends Error {
  constructor(public status: number) {
    super(`Upload rejected (${status})`);
  }
}

async function finalizeTrack(trackId: string, uploadToken: string, expectedChunks: number): Promise<number[] | null> {
  const res = await fetch(`${API_URL}/tracks/${trackId}/finalize`, {
    method: "POST",
    headers: { "x-upload-token": uploadToken, "Content-Type": "application/json" },
    body: JSON.stringify({ expectedChunks }),
  });
  if (res.status === 409) {
    const body = (await res.json()) as { missing?: number[] };
    if (body.missing) return body.missing;
    return null; // already finalised
  }
  if (res.status === 403 || res.status === 404) return null; // track no longer exists; nothing to do
  if (!res.ok) throw new Error(`Finalise failed (${res.status})`);
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Uploads a track's buffered chunks in order, retrying forever with backoff,
 * then finalises. Shared by the live recorder and by recovery after a reload.
 */
class Uploader {
  private queue: number[] = [];
  private running = false;
  private failures = 0;
  uploaded = 0;
  onProgress?: () => void;
  warning: string | null = null;

  constructor(
    private trackId: string,
    private uploadToken: string,
  ) {}

  push(index: number) {
    this.queue.push(index);
    void this.drain();
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const index = this.queue[0];
      const stored = await chunkStore.getChunk(this.trackId, index);
      if (!stored) {
        this.queue.shift();
        continue;
      }
      try {
        await uploadChunk(this.trackId, this.uploadToken, index, stored.blob);
        await chunkStore.deleteChunk(this.trackId, index);
        this.queue.shift();
        this.uploaded++;
        this.failures = 0;
        this.warning = null;
      } catch (err) {
        if (err instanceof FatalUploadError) {
          await chunkStore.deleteChunk(this.trackId, index);
          this.queue.shift();
          continue;
        }
        this.failures++;
        this.warning =
          this.failures >= 3 ? "Uploads are failing. Your audio is safe on this device and will be sent when the connection returns." : null;
        await sleep(Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5)));
      }
      this.onProgress?.();
    }
    this.running = false;
  }

  /** Resolves when every queued chunk is on the server. */
  async waitForIdle() {
    while (this.queue.length || this.running) await sleep(200);
  }

  async finalize(expectedChunks: number) {
    for (;;) {
      await this.waitForIdle();
      try {
        const missing = await finalizeTrack(this.trackId, this.uploadToken, expectedChunks);
        if (!missing || missing.length === 0) return;
        for (const i of missing) this.push(i);
      } catch {
        await sleep(3000);
      }
    }
  }
}

export class LocalRecorder {
  private recorder: MediaRecorder | null = null;
  private produced = 0;
  private uploader: Uploader;
  private stopped: Promise<void> | null = null;
  readonly mimeType: string;
  onProgress?: (p: RecorderProgress) => void;
  private state: UploadState = "idle";

  constructor(
    private stream: MediaStream,
    private trackId: string,
    private uploadToken: string,
  ) {
    this.mimeType = pickMimeType();
    this.uploader = new Uploader(trackId, uploadToken);
    this.uploader.onProgress = () => this.emit();
  }

  private emit() {
    this.onProgress?.({
      state: this.uploader.warning && this.state !== "done" ? "stuck" : this.state,
      produced: this.produced,
      uploaded: this.uploader.uploaded,
      warning: this.uploader.warning,
    });
  }

  async start() {
    // Record only the microphone track, never the remote voices.
    const micOnly = new MediaStream(this.stream.getAudioTracks());
    this.recorder = new MediaRecorder(micOnly, {
      ...(this.mimeType ? { mimeType: this.mimeType } : {}),
      audioBitsPerSecond: 128_000,
    });
    await chunkStore.saveTrack({
      trackId: this.trackId,
      uploadToken: this.uploadToken,
      mimeType: this.recorder.mimeType || this.mimeType,
      expectedChunks: null,
      createdAt: Date.now(),
    });

    let pendingWrites = Promise.resolve();
    this.stopped = new Promise<void>((resolve) => {
      this.recorder!.ondataavailable = (e) => {
        if (!e.data || e.data.size === 0) return;
        const index = this.produced++;
        // Write to IndexedDB first; only then hand it to the uploader.
        pendingWrites = pendingWrites.then(async () => {
          await chunkStore.saveChunk(this.trackId, index, e.data);
          this.uploader.push(index);
          this.emit();
        });
      };
      this.recorder!.onstop = () => {
        void pendingWrites.then(resolve);
      };
    });

    this.recorder.start(TIMESLICE_MS);
    this.state = "recording";
    this.emit();
  }

  /** Stops the recorder, uploads what is left and finalises on the server. */
  async stopAndFinish() {
    if (!this.recorder) return;
    if (this.recorder.state !== "inactive") this.recorder.stop();
    await this.stopped;
    this.state = "uploading";
    this.emit();
    await chunkStore.saveTrack({
      trackId: this.trackId,
      uploadToken: this.uploadToken,
      mimeType: this.recorder.mimeType || this.mimeType,
      expectedChunks: this.produced,
      createdAt: Date.now(),
    });
    await this.uploader.finalize(this.produced);
    await chunkStore.deleteTrack(this.trackId);
    this.state = "done";
    this.emit();
  }
}

/**
 * Finishes any upload that was interrupted (tab closed, browser crashed).
 * Safe to call on every page load; does nothing when there is nothing to do.
 */
export async function resumePendingUploads(onDone?: (trackId: string) => void) {
  let tracks;
  try {
    tracks = await chunkStore.listTracks();
  } catch {
    return;
  }
  for (const t of tracks) {
    const indexes = await chunkStore.listChunkIndexes(t.trackId);
    const uploader = new Uploader(t.trackId, t.uploadToken);
    for (const i of indexes) uploader.push(i);
    // If the recorder never reported a final count the best estimate is what we have.
    const expected = t.expectedChunks ?? (indexes.length ? indexes[indexes.length - 1] + 1 : 0);
    void (async () => {
      try {
        await uploader.finalize(expected);
      } finally {
        await chunkStore.deleteTrack(t.trackId);
        onDone?.(t.trackId);
      }
    })();
  }
}
