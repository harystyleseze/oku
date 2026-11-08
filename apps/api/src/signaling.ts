import type { Server as HttpServer, IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "./db.js";
import { conversations, participants, rooms as roomsTable, tracks } from "./schema.js";
import { userFromSessionId, SESSION_COOKIE } from "./auth.js";
import { iceServers } from "./config.js";
import { SPEAKER_COLORS } from "./presets.js";
import { enqueue } from "./queue.js";

/**
 * The Space: one WebSocket per participant. The server does three things only:
 * keeps the list of who is in the room, relays WebRTC offers/answers/candidates
 * between peers (audio flows peer-to-peer, not through us), and tells every
 * browser when the host starts or stops a recording.
 */

const GRACE_AFTER_STOP_MS = 90_000; // process with whatever has arrived if an uploader never finalises

interface Peer {
  id: string;
  ws: WebSocket;
  name: string;
  color: string;
  isHost: boolean;
  userId?: string;
  participantId?: string; // set while a recording is active
}

interface ActiveRecording {
  conversationId: string;
  graceTimer?: NodeJS.Timeout;
}

interface RoomState {
  slug: string;
  roomId: string;
  hostId: string;
  title: string;
  peers: Map<string, Peer>;
  joinCount: number;
  recording: ActiveRecording | null;
}

const rooms = new Map<string, RoomState>();

const clientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), name: z.string().trim().min(1).max(40), consent: z.literal(true) }),
  z.object({ type: z.literal("signal"), to: z.string(), data: z.unknown() }),
  z.object({ type: z.literal("start-recording"), title: z.string().trim().max(120).optional() }),
  z.object({ type: z.literal("recorder-started"), mimeType: z.string().max(100) }),
  z.object({ type: z.literal("stop-recording") }),
]);

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room: RoomState, msg: unknown, except?: string) {
  for (const p of room.peers.values()) if (p.id !== except) send(p.ws, msg);
}

function publicPeer(p: Peer) {
  return { id: p.id, name: p.name, color: p.color, isHost: p.isHost };
}

function parseCookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function attachSignaling(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const slug = url.searchParams.get("room");
    if (!slug) return ws.close(4000, "Missing room");

    // The browser may send "join" before the lookups below finish; hold those messages.
    const early: Buffer[] = [];
    const holdEarly = (buf: Buffer) => early.push(buf);
    ws.on("message", holdEarly);

    const roomRow = await db.query.rooms.findFirst({ where: eq(roomsTable.slug, slug) });
    if (!roomRow) return ws.close(4004, "Room not found");

    const user = await userFromSessionId(parseCookie(req, SESSION_COOKIE));

    let room = rooms.get(slug);
    if (!room) {
      room = { slug, roomId: roomRow.id, hostId: roomRow.hostId, title: roomRow.title, peers: new Map(), joinCount: 0, recording: null };
      rooms.set(slug, room);
    }
    const state = room;

    let peer: Peer | null = null;

    const onMessage = async (buf: Buffer) => {
      let msg: z.infer<typeof clientMessage>;
      try {
        msg = clientMessage.parse(JSON.parse(buf.toString()));
      } catch {
        return send(ws, { type: "error", message: "Malformed message." });
      }

      try {
        if (msg.type === "join") {
          if (peer) return;
          peer = {
            id: randomUUID(),
            ws,
            name: msg.name,
            color: SPEAKER_COLORS[state.joinCount % SPEAKER_COLORS.length],
            isHost: !!user && user.id === state.hostId,
            userId: user?.id,
          };
          state.joinCount++;
          const others = [...state.peers.values()].map(publicPeer);
          state.peers.set(peer.id, peer);

          send(ws, {
            type: "welcome",
            peerId: peer.id,
            isHost: peer.isHost,
            color: peer.color,
            roomTitle: state.title,
            peers: others,
            iceServers: iceServers(),
            recording: state.recording ? { conversationId: state.recording.conversationId } : null,
          });
          broadcast(state, { type: "peer-joined", peer: publicPeer(peer) }, peer.id);

          // Someone arriving mid-recording starts recording too.
          if (state.recording) await addParticipant(state, peer, state.recording.conversationId);
          return;
        }

        if (!peer) return send(ws, { type: "error", message: "Join the room first." });

        if (msg.type === "signal") {
          const target = state.peers.get(msg.to);
          if (target) send(target.ws, { type: "signal", from: peer.id, data: msg.data });
          return;
        }

        if (msg.type === "start-recording") {
          if (!peer.isHost) return send(ws, { type: "error", message: "Only the host can start recording." });
          if (state.recording) return;
          const [conversation] = await db
            .insert(conversations)
            .values({ roomId: state.roomId, title: msg.title?.trim() || defaultTitle(state.title) })
            .returning({ id: conversations.id });
          state.recording = { conversationId: conversation.id };
          for (const p of state.peers.values()) await addParticipant(state, p, conversation.id);
          return;
        }

        if (msg.type === "recorder-started") {
          if (!peer.participantId) return;
          await db.update(participants).set({ recorderStartedAt: new Date() }).where(eq(participants.id, peer.participantId));
          await db.update(tracks).set({ mimeType: msg.mimeType }).where(eq(tracks.participantId, peer.participantId));
          return;
        }

        if (msg.type === "stop-recording") {
          if (!peer.isHost) return send(ws, { type: "error", message: "Only the host can stop recording." });
          if (!state.recording) return;
          await stopRecording(state);
          return;
        }
      } catch (err) {
        console.error("[signaling]", err);
        send(ws, { type: "error", message: "Something went wrong on the server." });
      }
    };

    ws.off("message", holdEarly);
    ws.on("message", (buf) => void onMessage(buf as Buffer));
    for (const buf of early) await onMessage(buf);

    ws.on("close", () => {
      if (!peer) return;
      state.peers.delete(peer.id);
      broadcast(state, { type: "peer-left", peerId: peer.id });
      // If the host drops mid-recording the recording keeps going; guests still upload.
      // When the room empties while recording, finish it so the audio is not left in limbo.
      if (state.peers.size === 0) {
        if (state.recording) void stopRecording(state);
        else rooms.delete(slug);
      }
    });
  });
}

function defaultTitle(roomTitle: string) {
  const d = new Date();
  return `${roomTitle} — ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
}

async function addParticipant(state: RoomState, peer: Peer, conversationId: string) {
  const [participant] = await db
    .insert(participants)
    .values({ conversationId, displayName: peer.name, color: peer.color, isHost: peer.isHost })
    .returning({ id: participants.id });
  const [track] = await db
    .insert(tracks)
    .values({ participantId: participant.id })
    .returning({ id: tracks.id, uploadToken: tracks.uploadToken });
  peer.participantId = participant.id;
  send(peer.ws, { type: "recording-started", conversationId, trackId: track.id, uploadToken: track.uploadToken });
}

async function stopRecording(state: RoomState) {
  const rec = state.recording;
  if (!rec) return;
  state.recording = null;
  for (const p of state.peers.values()) p.participantId = undefined;
  await db.update(conversations).set({ endedAt: new Date() }).where(eq(conversations.id, rec.conversationId));
  broadcast(state, { type: "recording-stopped", conversationId: rec.conversationId });
  if (state.peers.size === 0) rooms.delete(state.slug);
  // Processing starts when every track is finalised (see routes) or after the grace period.
  setTimeout(() => void processIfReady(rec.conversationId, true), GRACE_AFTER_STOP_MS).unref();
}

/**
 * Called whenever a track is finalised and once after the grace period.
 * Kicks off processing exactly once, when all uploads are in (or time is up).
 */
export async function processIfReady(conversationId: string, force = false) {
  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    with: { participants: { with: { track: true } } },
  });
  if (!conversation || conversation.status !== "recording" || !conversation.endedAt) return;
  const allDone = conversation.participants.every((p) => !p.track || p.track.status !== "uploading");
  if (!allDone && !force) return;
  // Claim it atomically so the grace timer and the last finalise cannot both enqueue.
  const claimed = await db
    .update(conversations)
    .set({ status: "processing" })
    .where(and(eq(conversations.id, conversationId), eq(conversations.status, "recording")))
    .returning({ id: conversations.id });
  if (claimed.length === 1) enqueue({ kind: "process", conversationId });
}
