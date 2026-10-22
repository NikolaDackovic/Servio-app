CREATE TYPE "public"."fiscal_status" AS ENUM('PENDING', 'SIGNED', 'FAILED', 'NOT_REQUIRED');--> statement-breakpoint
CREATE TYPE "public"."kds_ticket_status" AS ENUM('NEW', 'IN_PROGRESS', 'READY', 'DONE');--> statement-breakpoint
CREATE TYPE "public"."print_job_kind" AS ENUM('ORDER_TICKET', 'VOID_TICKET', 'RECEIPT', 'TEST_PAGE');--> statement-breakpoint
CREATE TYPE "public"."print_job_status" AS ENUM('PENDING', 'PRINTING', 'PRINTED', 'SIMULATED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."printer_connection" AS ENUM('SIMULATED', 'NETWORK_ESCPOS', 'WINDOWS_RAW');--> statement-breakpoint
CREATE TYPE "public"."station_kind" AS ENUM('BAR', 'KITCHEN', 'OTHER');--> statement-breakpoint
ALTER TYPE "public"."device_kind" ADD VALUE 'BRIDGE';--> statement-breakpoint
CREATE TABLE "fiscal_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"transaction_type" varchar(12) DEFAULT 'SALE' NOT NULL,
	"invoice_type" varchar(12) NOT NULL,
	"status" "fiscal_status" DEFAULT 'PENDING' NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"invoice_number" varchar(80),
	"verification_url" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"signed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_signed_has_number" CHECK ("fiscal_receipts"."status" <> 'SIGNED' OR ("fiscal_receipts"."invoice_number" IS NOT NULL AND "fiscal_receipts"."signed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "kds_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"batch" integer NOT NULL,
	"status" "kds_ticket_status" DEFAULT 'NEW' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp (3) with time zone,
	"ready_at" timestamp (3) with time zone,
	"done_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "prep_stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "station_kind" DEFAULT 'OTHER' NOT NULL,
	"printer_id" uuid,
	"kds_enabled" boolean DEFAULT true NOT NULL,
	"warehouse_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"printer_id" uuid NOT NULL,
	"station_id" uuid,
	"order_id" uuid,
	"kind" "print_job_kind" NOT NULL,
	"dedupe_key" varchar(160) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "print_job_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"claimed_by_device_id" uuid,
	"claimed_at" timestamp (3) with time zone,
	"finished_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "printers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"connection" "printer_connection" DEFAULT 'SIMULATED' NOT NULL,
	"host" varchar(120),
	"port" integer,
	"windows_name" text,
	"paper_width" integer DEFAULT 80 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "printers_paper" CHECK ("printers"."paper_width" IN (58, 80)),
	CONSTRAINT "printers_network_cfg" CHECK ("printers"."connection" <> 'NETWORK_ESCPOS' OR ("printers"."host" IS NOT NULL AND "printers"."port" BETWEEN 1 AND 65535)),
	CONSTRAINT "printers_windows_cfg" CHECK ("printers"."connection" <> 'WINDOWS_RAW' OR "printers"."windows_name" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "prep_station_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "api_key_hash" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "api_key_prefix" varchar(12);--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "last_seen_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "receipt_printer_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "prep_station_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "kds_ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "ready_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "prep_station_id" uuid;--> statement-breakpoint
ALTER TABLE "fiscal_receipts" ADD CONSTRAINT "fiscal_receipts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_receipts" ADD CONSTRAINT "fiscal_receipts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kds_tickets" ADD CONSTRAINT "kds_tickets_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kds_tickets" ADD CONSTRAINT "kds_tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kds_tickets" ADD CONSTRAINT "kds_tickets_station_id_prep_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."prep_stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_stations" ADD CONSTRAINT "prep_stations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_stations" ADD CONSTRAINT "prep_stations_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_station_id_prep_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."prep_stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_order_tx_uq" ON "fiscal_receipts" USING btree ("order_id","transaction_type");--> statement-breakpoint
CREATE INDEX "fiscal_queue_idx" ON "fiscal_receipts" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "kds_ticket_order_batch_station_uq" ON "kds_tickets" USING btree ("order_id","batch","station_id");--> statement-breakpoint
CREATE INDEX "kds_station_status_idx" ON "kds_tickets" USING btree ("station_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "stations_location_name_uq" ON "prep_stations" USING btree ("location_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "print_jobs_dedupe_uq" ON "print_jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "print_jobs_queue_idx" ON "print_jobs" USING btree ("location_id","status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "printers_location_name_uq" ON "printers" USING btree ("location_id","name");--> statement-breakpoint
-- Novo pravo: rad na KDS ekranu; upravljanje štampom/pozicijama; fiskalni pregled
UPDATE "roles" SET "permissions" = array_append("permissions", 'kds.use')
WHERE "code" IN ('ADMIN', 'OWNER', 'MANAGER', 'KITCHEN', 'CASHIER') AND NOT ('kds.use' = ANY("permissions"));
--> statement-breakpoint
UPDATE "roles" SET "permissions" = array_append("permissions", 'settings.manage')
WHERE "code" IN ('ADMIN', 'OWNER', 'MANAGER') AND NOT ('settings.manage' = ANY("permissions"));
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_prep_station_fk" FOREIGN KEY ("prep_station_id") REFERENCES "public"."prep_stations"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_prep_station_fk" FOREIGN KEY ("prep_station_id") REFERENCES "public"."prep_stations"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_prep_station_fk" FOREIGN KEY ("prep_station_id") REFERENCES "public"."prep_stations"("id");
--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_kds_ticket_fk" FOREIGN KEY ("kds_ticket_id") REFERENCES "public"."kds_tickets"("id");
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_receipt_printer_fk" FOREIGN KEY ("receipt_printer_id") REFERENCES "public"."printers"("id") ON DELETE set null;
