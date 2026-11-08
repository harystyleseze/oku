import { relations, sql } from "drizzle-orm";
import { boolean, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// A Room is a permanent link the host can reuse. Each recording in it is a Conversation.
export const rooms = pgTable(
  "rooms",
  {
    id: id(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    hostId: uuid("host_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [index("rooms_host_idx").on(t.hostId)],
);

export const conversationStatus = pgEnum("conversation_status", ["recording", "processing", "ready", "failed"]);

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: conversationStatus("status").notNull().default("recording"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    mixedKey: text("mixed_key"), // storage key of the mixed-down audio (m4a)
    peaksKey: text("peaks_key"), // storage key of waveform peaks JSON
    error: text("error"),
  },
  (t) => [index("conversations_room_idx").on(t.roomId)],
);

export const participants = pgTable(
  "participants",
  {
    id: id(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    color: text("color").notNull(), // hex, assigned by join order
    isHost: boolean("is_host").notNull().default(false),
    // Server time when this participant's recorder reported it had started. Aligns tracks when mixing.
    recorderStartedAt: timestamp("recorder_started_at", { withTimezone: true }),
  },
  (t) => [index("participants_conversation_idx").on(t.conversationId)],
);

export const trackStatus = pgEnum("track_status", ["uploading", "finalized", "processed", "failed"]);

export const tracks = pgTable("tracks", {
  id: id(),
  participantId: uuid("participant_id").notNull().unique().references(() => participants.id, { onDelete: "cascade" }),
  mimeType: text("mime_type").notNull().default(""),
  // Guests have no account; this secret lets exactly one browser upload to this track.
  uploadToken: uuid("upload_token").notNull().unique().default(sql`gen_random_uuid()`),
  status: trackStatus("status").notNull().default("uploading"),
  chunkCount: integer("chunk_count").notNull().default(0),
  expectedChunks: integer("expected_chunks"), // set on finalize
  bytes: integer("bytes").notNull().default(0),
  processedKey: text("processed_key"), // per-speaker clean audio (m4a)
  durationMs: integer("duration_ms"),
});

export const chunks = pgTable(
  "chunks",
  {
    trackId: uuid("track_id").notNull().references(() => tracks.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    key: text("key").notNull(),
    bytes: integer("bytes").notNull(),
  },
  (t) => [primaryKey({ columns: [t.trackId, t.index] })],
);

export const exportStatus = pgEnum("export_status", ["queued", "rendering", "ready", "failed"]);

export const exports = pgTable(
  "exports",
  {
    id: id(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(), // tiktok | reels | shorts | x | youtube
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    title: text("title").notNull(),
    theme: text("theme").notNull().default("night"),
    status: exportStatus("status").notNull().default("queued"),
    outputKey: text("output_key"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("exports_conversation_idx").on(t.conversationId)],
);

// ---------- relations (for db.query.* nested reads) ----------

export const usersRelations = relations(users, ({ many }) => ({ sessions: many(sessions), rooms: many(rooms) }));
export const sessionsRelations = relations(sessions, ({ one }) => ({ user: one(users, { fields: [sessions.userId], references: [users.id] }) }));
export const roomsRelations = relations(rooms, ({ one, many }) => ({
  host: one(users, { fields: [rooms.hostId], references: [users.id] }),
  conversations: many(conversations),
}));
export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  room: one(rooms, { fields: [conversations.roomId], references: [rooms.id] }),
  participants: many(participants),
  exports: many(exports),
}));
export const participantsRelations = relations(participants, ({ one }) => ({
  conversation: one(conversations, { fields: [participants.conversationId], references: [conversations.id] }),
  track: one(tracks, { fields: [participants.id], references: [tracks.participantId] }),
}));
export const tracksRelations = relations(tracks, ({ one, many }) => ({
  participant: one(participants, { fields: [tracks.participantId], references: [participants.id] }),
  chunks: many(chunks),
}));
export const chunksRelations = relations(chunks, ({ one }) => ({ track: one(tracks, { fields: [chunks.trackId], references: [tracks.id] }) }));
export const exportsRelations = relations(exports, ({ one }) => ({
  conversation: one(conversations, { fields: [exports.conversationId], references: [conversations.id] }),
}));

export type User = typeof users.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Participant = typeof participants.$inferSelect;
export type Track = typeof tracks.$inferSelect;
export type Export = typeof exports.$inferSelect;
