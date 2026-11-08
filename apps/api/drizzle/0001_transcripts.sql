CREATE TYPE "public"."transcript_status" AS ENUM('none', 'queued', 'running', 'ready', 'failed');--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "transcript_status" "transcript_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "transcript_key" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "transcript_error" text;--> statement-breakpoint
ALTER TABLE "exports" ADD COLUMN "captions" boolean DEFAULT false NOT NULL;