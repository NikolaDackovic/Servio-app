ALTER TYPE "public"."order_status" ADD VALUE 'MERGED';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'REPRESENTATION';--> statement-breakpoint
CREATE TABLE "discounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"percent" numeric(5, 2) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discounts_percent_range" CHECK ("discounts"."percent" > 0 AND "discounts"."percent" <= 100)
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "discount_amount" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tab_name" varchar(40);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_percent" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "subtotal" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_total" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- Postojeći računi: subtotal = total (do sada nije bilo popusta) — pre CHECK ograničenja
UPDATE "orders" SET "subtotal" = "total";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_id_type" varchar(4);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_id" varchar(40);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_optional_basis" varchar(60);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_optional_value" varchar(60);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discounts_org_name_uq" ON "discounts" USING btree ("organization_id","name");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_discount_id_discounts_id_fk" FOREIGN KEY ("discount_id") REFERENCES "public"."discounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_discount_range" CHECK ("order_items"."discount_amount" >= 0 AND "order_items"."discount_amount" <= "order_items"."line_total");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_discount_range" CHECK ("orders"."discount_percent" >= 0 AND "orders"."discount_percent" <= 100);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_is_subtotal_minus_discount" CHECK ("orders"."total" = "orders"."subtotal" - "orders"."discount_total");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_complete" CHECK (("orders"."buyer_id_type" IS NULL) = ("orders"."buyer_id" IS NULL));--> statement-breakpoint
-- Novo pravo: primena popusta na računu (konobar, kasir, menadžer; admin/vlasnik imaju sva prava)
UPDATE "roles" SET "permissions" = array_append("permissions", 'order.discount')
WHERE "code" IN ('ADMIN', 'OWNER', 'MANAGER', 'CASHIER', 'WAITER') AND NOT ('order.discount' = ANY("permissions"));
--> statement-breakpoint
UPDATE "roles" SET "permissions" = array_append("permissions", 'discount.manage')
WHERE "code" IN ('ADMIN', 'OWNER', 'MANAGER') AND NOT ('discount.manage' = ANY("permissions"));
