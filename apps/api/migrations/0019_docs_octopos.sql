ALTER TYPE "stock_doc_kind" ADD VALUE IF NOT EXISTS 'CORRECTION';--> statement-breakpoint
ALTER TABLE "stock_documents" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD COLUMN "internal_note" text;--> statement-breakpoint
ALTER TABLE "stock_document_lines" ADD COLUMN "discount_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "stock_document_lines" DROP CONSTRAINT IF EXISTS "stock_document_lines_qty_nonneg";
