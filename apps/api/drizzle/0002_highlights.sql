ALTER TABLE "conversations" ADD COLUMN "highlights_status" "transcript_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "highlights" jsonb;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "highlights_error" text;