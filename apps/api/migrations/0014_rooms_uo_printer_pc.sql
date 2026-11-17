ALTER TYPE "public"."stock_doc_kind" ADD VALUE 'RECEIPT_NOTE';--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "is_room" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "bridge_device_id" uuid;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_bridge_device_id_devices_id_fk" FOREIGN KEY ("bridge_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "roles" ("organization_id", "code", "name", "permissions")
SELECT o."id", 'BARTENDER', 'Šanker', ARRAY['catalog.read','table.read','order.read','order.write','order.split','payment.create','order.discount','kds.use']::text[]
FROM "organizations" o WHERE NOT EXISTS (SELECT 1 FROM "roles" r WHERE r."organization_id" = o."id" AND r."code" = 'BARTENDER');--> statement-breakpoint
INSERT INTO "roles" ("organization_id", "code", "name", "permissions")
SELECT o."id", 'ACCOUNTANT', 'Knjigovođa', ARRAY['catalog.read','report.read','audit.read','stock.read','stock.write','stock.post']::text[]
FROM "organizations" o WHERE NOT EXISTS (SELECT 1 FROM "roles" r WHERE r."organization_id" = o."id" AND r."code" = 'ACCOUNTANT');
