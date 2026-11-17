ALTER TABLE "categories" ADD COLUMN "printer_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "purchase_tax_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "min_stock" numeric(16, 4);