ALTER TYPE "public"."print_job_kind" ADD VALUE 'SHIFT_REPORT';--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "note_options" jsonb DEFAULT '[]'::jsonb NOT NULL;