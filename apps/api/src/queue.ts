import { asc, eq, inArray } from "drizzle-orm";
import { db } from "./db.js";
import { conversations, exports } from "./schema.js";
import { processConversation, renderExport } from "./processing.js";

/**
 * A single in-process job queue. ffmpeg work runs one job at a time so a busy
 * export never starves a conversation that has just finished recording.
 * Jobs are recorded in the database, so a restart picks up where it left off.
 */
type Job = { kind: "process"; conversationId: string } | { kind: "export"; exportId: string };

const pending: Job[] = [];
let running = false;

export function enqueue(job: Job) {
  pending.push(job);
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  while (pending.length) {
    const job = pending.shift()!;
    try {
      if (job.kind === "process") await processConversation(job.conversationId);
      else await renderExport(job.exportId);
    } catch (err) {
      console.error(`[queue] ${job.kind} failed:`, err instanceof Error ? err.message : err);
    }
  }
  running = false;
}

/** Re-enqueue anything that was mid-flight when the server last stopped. */
export async function resumeInterruptedJobs() {
  const stuck = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.status, "processing"));
  for (const c of stuck) enqueue({ kind: "process", conversationId: c.id });

  const pendingExports = await db
    .select({ id: exports.id })
    .from(exports)
    .where(inArray(exports.status, ["queued", "rendering"]))
    .orderBy(asc(exports.createdAt));
  for (const e of pendingExports) enqueue({ kind: "export", exportId: e.id });
}
