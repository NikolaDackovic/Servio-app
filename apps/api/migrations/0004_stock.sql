CREATE TYPE "public"."movement_source" AS ENUM('DOCUMENT', 'SALE', 'REVERSAL');--> statement-breakpoint
CREATE TYPE "public"."partner_kind" AS ENUM('SUPPLIER', 'CUSTOMER', 'BOTH');--> statement-breakpoint
CREATE TYPE "public"."recipe_status" AS ENUM('DRAFT', 'ACTIVE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."stock_doc_kind" AS ENUM('RECEIPT', 'ISSUE', 'RETURN', 'TRANSFER', 'WRITE_OFF', 'INTERNAL', 'STOCKTAKE');--> statement-breakpoint
CREATE TYPE "public"."stock_doc_status" AS ENUM('DRAFT', 'POSTED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "partner_kind" DEFAULT 'SUPPLIER' NOT NULL,
	"tax_id" varchar(9),
	"registration_no" varchar(8),
	"address" text,
	"city" text,
	"email" varchar(120),
	"phone" varchar(40),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"quantity" numeric(16, 4) NOT NULL,
	CONSTRAINT "recipe_lines_qty_pos" CHECK ("recipe_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "recipe_status" DEFAULT 'DRAFT' NOT NULL,
	"note" text,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp (3) with time zone,
	"retired_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"warehouse_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" numeric(16, 4) DEFAULT '0' NOT NULL,
	"avg_cost" numeric(16, 4) DEFAULT '0' NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_warehouse_id_product_id_pk" PRIMARY KEY("warehouse_id","product_id"),
	CONSTRAINT "stock_balances_avg_nonneg" CHECK ("stock_balances"."avg_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_document_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" numeric(16, 4) NOT NULL,
	"unit_cost" numeric(16, 4),
	"book_quantity" numeric(16, 4),
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "stock_document_lines_qty_nonneg" CHECK ("stock_document_lines"."quantity" >= 0),
	CONSTRAINT "stock_document_lines_cost_nonneg" CHECK ("stock_document_lines"."unit_cost" IS NULL OR "stock_document_lines"."unit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" "stock_doc_kind" NOT NULL,
	"status" "stock_doc_status" DEFAULT 'DRAFT' NOT NULL,
	"number" integer,
	"warehouse_id" uuid NOT NULL,
	"target_warehouse_id" uuid,
	"partner_id" uuid,
	"doc_date" date NOT NULL,
	"external_number" varchar(60),
	"note" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid NOT NULL,
	"posted_by_id" uuid,
	"posted_at" timestamp (3) with time zone,
	"cancelled_by_id" uuid,
	"cancelled_at" timestamp (3) with time zone,
	"cancel_reason" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_documents_posted_has_number" CHECK ("stock_documents"."status" = 'DRAFT' OR "stock_documents"."number" IS NOT NULL OR "stock_documents"."posted_at" IS NULL),
	CONSTRAINT "stock_documents_transfer_target" CHECK ("stock_documents"."kind" <> 'TRANSFER' OR ("stock_documents"."target_warehouse_id" IS NOT NULL AND "stock_documents"."target_warehouse_id" <> "stock_documents"."warehouse_id")),
	CONSTRAINT "stock_documents_cancel_reason" CHECK ("stock_documents"."status" <> 'CANCELLED' OR "stock_documents"."cancel_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"location_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" numeric(16, 4) NOT NULL,
	"unit_cost" numeric(16, 4) NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"balance_after" numeric(16, 4) NOT NULL,
	"avg_cost_after" numeric(16, 4) NOT NULL,
	"source" "movement_source" NOT NULL,
	"document_id" uuid,
	"document_line_id" uuid,
	"order_id" uuid,
	"order_item_id" uuid,
	"recipe_id" uuid,
	"reverses_movement_id" uuid,
	"created_by_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_qty_nonzero" CHECK ("stock_movements"."quantity" <> 0)
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "track_stock" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_sellable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_component_id_products_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_document_id_stock_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."stock_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_target_warehouse_id_warehouses_id_fk" FOREIGN KEY ("target_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_posted_by_id_users_id_fk" FOREIGN KEY ("posted_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_cancelled_by_id_users_id_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_document_id_stock_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."stock_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_document_line_id_stock_document_lines_id_fk" FOREIGN KEY ("document_line_id") REFERENCES "public"."stock_document_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partners_org_taxid_uq" ON "partners" USING btree ("organization_id","tax_id") WHERE "partners"."tax_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "partners_org_name_idx" ON "partners" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_lines_recipe_component_uq" ON "recipe_lines" USING btree ("recipe_id","component_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_product_version_uq" ON "recipes" USING btree ("product_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_one_active_uq" ON "recipes" USING btree ("product_id") WHERE "recipes"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "stock_document_lines_doc_idx" ON "stock_document_lines" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_document_lines_doc_product_uq" ON "stock_document_lines" USING btree ("document_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_documents_number_uq" ON "stock_documents" USING btree ("location_id","kind","number") WHERE "stock_documents"."number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stock_documents_list_idx" ON "stock_documents" USING btree ("location_id","kind","status");--> statement-breakpoint
CREATE INDEX "stock_movements_card_idx" ON "stock_movements" USING btree ("warehouse_id","product_id","seq");--> statement-breakpoint
CREATE INDEX "stock_movements_doc_idx" ON "stock_movements" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_sale_uq" ON "stock_movements" USING btree ("order_item_id","product_id") WHERE "stock_movements"."source" = 'SALE';--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_doc_line_uq" ON "stock_movements" USING btree ("document_line_id","warehouse_id") WHERE "stock_movements"."source" = 'DOCUMENT';--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_reversal_uq" ON "stock_movements" USING btree ("reverses_movement_id") WHERE "stock_movements"."reverses_movement_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_location_name_uq" ON "warehouses" USING btree ("location_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_one_default_uq" ON "warehouses" USING btree ("location_id") WHERE "warehouses"."is_default";--> statement-breakpoint
ALTER TABLE "prep_stations" ADD CONSTRAINT "prep_stations_warehouse_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null;
--> statement-breakpoint
-- Svaki postojeći lokal dobija podrazumevano skladište (prodaja uvek ima odakle da troši).
INSERT INTO "warehouses" ("location_id", "name", "is_default")
SELECT "id", 'Glavni magacin', true FROM "locations" l
WHERE NOT EXISTS (SELECT 1 FROM "warehouses" w WHERE w."location_id" = l."id");
--> statement-breakpoint
-- Prava za robno: pregled, izrada nacrta, knjiženje/storno
UPDATE "roles" SET "permissions" = array_append("permissions", 'stock.read')
WHERE "code" IN ('ADMIN', 'OWNER', 'MANAGER') AND NOT ('stock.read' = ANY("permissions"));
--> statement-breakpoint
UPDATE "roles" SET "permissions" = array_append("permissions", 'stock.write')
WHERE "code" IN ('ADMIN', 'OWNER', 'MANAGER') AND NOT ('stock.write' = ANY("permissions"));
--> statement-breakpoint
UPDATE "roles" SET "permissions" = array_append("permissions", 'stock.post')
WHERE "code" IN ('ADMIN', 'OWNER', 'MANAGER') AND NOT ('stock.post' = ANY("permissions"));
