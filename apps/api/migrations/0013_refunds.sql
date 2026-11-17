ALTER TYPE "public"."movement_source" ADD VALUE 'REFUND';--> statement-breakpoint
CREATE TABLE "refund_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	CONSTRAINT "refund_items_qty_pos" CHECK ("refund_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"business_day_id" uuid,
	"shift_id" uuid,
	"device_id" uuid,
	"number" integer NOT NULL,
	"method" "payment_method" NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" varchar(80) NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_total_pos" CHECK ("refunds"."total" > 0)
);
--> statement-breakpoint
DROP INDEX "fiscal_order_tx_uq";--> statement-breakpoint
ALTER TABLE "fiscal_receipts" ADD COLUMN "refund_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "refund_id" uuid;--> statement-breakpoint
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_business_day_id_business_days_id_fk" FOREIGN KEY ("business_day_id") REFERENCES "public"."business_days"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_shift_id_cash_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."cash_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refund_items_item_idx" ON "refund_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_order_idem_uq" ON "refunds" USING btree ("order_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "refunds_business_day_idx" ON "refunds" USING btree ("business_day_id");--> statement-breakpoint
ALTER TABLE "fiscal_receipts" ADD CONSTRAINT "fiscal_receipts_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_order_sale_uq" ON "fiscal_receipts" USING btree ("order_id") WHERE "fiscal_receipts"."transaction_type" = 'SALE';--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_refund_uq" ON "fiscal_receipts" USING btree ("refund_id");--> statement-breakpoint
UPDATE "roles" SET "permissions" = array_append("permissions", 'order.refund') WHERE 'order.void' = ANY("permissions") AND NOT ('order.refund' = ANY("permissions"));
