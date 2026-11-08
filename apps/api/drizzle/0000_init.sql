CREATE TYPE "public"."conversation_status" AS ENUM('recording', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."export_status" AS ENUM('queued', 'rendering', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."track_status" AS ENUM('uploading', 'finalized', 'processed', 'failed');--> statement-breakpoint
CREATE TABLE "chunks" (
	"track_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"key" text NOT NULL,
	"bytes" integer NOT NULL,
	CONSTRAINT "chunks_track_id_index_pk" PRIMARY KEY("track_id","index")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "conversation_status" DEFAULT 'recording' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"mixed_key" text,
	"peaks_key" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"title" text NOT NULL,
	"theme" text DEFAULT 'night' NOT NULL,
	"status" "export_status" DEFAULT 'queued' NOT NULL,
	"output_key" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"color" text NOT NULL,
	"is_host" boolean DEFAULT false NOT NULL,
	"recorder_started_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"host_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"mime_type" text DEFAULT '' NOT NULL,
	"upload_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"status" "track_status" DEFAULT 'uploading' NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"expected_chunks" integer,
	"bytes" integer DEFAULT 0 NOT NULL,
	"processed_key" text,
	"duration_ms" integer,
	CONSTRAINT "tracks_participant_id_unique" UNIQUE("participant_id"),
	CONSTRAINT "tracks_upload_token_unique" UNIQUE("upload_token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_room_idx" ON "conversations" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "exports_conversation_idx" ON "exports" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "participants_conversation_idx" ON "participants" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "rooms_host_idx" ON "rooms" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");