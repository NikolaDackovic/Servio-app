CREATE TYPE "public"."cash_movement_type" AS ENUM('PAY_IN', 'PAY_OUT');--> statement-breakpoint
CREATE TYPE "public"."device_kind" AS ENUM('POS', 'MOBILE', 'KDS');--> statement-breakpoint
CREATE TYPE "public"."order_item_status" AS ENUM('NEW', 'SENT', 'VOIDED');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('OPEN', 'PAID', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CASH', 'CARD', 'TRANSFER');--> statement-breakpoint
CREATE TYPE "public"."payment_mode" AS ENUM('TEST', 'LIVE');--> statement-breakpoint
CREATE TYPE "public"."shift_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"action" varchar(64) NOT NULL,
	"entity" varchar(64) NOT NULL,
	"entity_id" text NOT NULL,
	"data" jsonb,
	"request_id" varchar(64),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_id" uuid NOT NULL,
	"type" "cash_movement_type" NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"reason" text NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movements_amount_pos" CHECK ("cash_movements"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "cash_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"status" "shift_status" DEFAULT 'OPEN' NOT NULL,
	"opened_by_id" uuid NOT NULL,
	"closed_by_id" uuid,
	"opening_cash" numeric(14, 2) NOT NULL,
	"expected_cash" numeric(14, 2),
	"counted_cash" numeric(14, 2),
	"difference" numeric(14, 2),
	"opened_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp (3) with time zone,
	CONSTRAINT "shifts_opening_cash_nonneg" CHECK ("cash_shifts"."opening_cash" >= 0)
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" varchar(16),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "device_kind" DEFAULT 'POS' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dining_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"area" text DEFAULT 'Sala' NOT NULL,
	"name" text NOT NULL,
	"seats" integer DEFAULT 4 NOT NULL,
	"pos_x" integer DEFAULT 0 NOT NULL,
	"pos_y" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_counters" (
	"location_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "document_counters_location_id_kind_pk" PRIMARY KEY("location_id","kind")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"timezone" text DEFAULT 'Europe/Belgrade' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"tax_label" varchar(4) NOT NULL,
	"tax_rate" numeric(5, 2) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	"note" text,
	"status" "order_item_status" DEFAULT 'NEW' NOT NULL,
	"send_batch" integer,
	"sent_at" timestamp (3) with time zone,
	"void_reason" text,
	"voided_by_id" uuid,
	"voided_at" timestamp (3) with time zone,
	"added_by_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_qty_pos" CHECK ("order_items"."quantity" > 0),
	CONSTRAINT "order_items_price_nonneg" CHECK ("order_items"."unit_price" >= 0),
	CONSTRAINT "order_items_void_has_reason" CHECK ("order_items"."status" <> 'VOIDED' OR ("order_items"."void_reason" IS NOT NULL AND "order_items"."voided_by_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"device_id" uuid,
	"table_id" uuid,
	"number" integer NOT NULL,
	"status" "order_status" DEFAULT 'OPEN' NOT NULL,
	"guests" integer,
	"note" text,
	"opened_by_id" uuid NOT NULL,
	"waiter_id" uuid NOT NULL,
	"closed_by_id" uuid,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"paid_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"send_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"idempotency_key" varchar(80),
	"opened_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_total_nonneg" CHECK ("orders"."total" >= 0),
	CONSTRAINT "orders_paid_not_over_total" CHECK ("orders"."paid_total" >= 0 AND "orders"."paid_total" <= "orders"."total"),
	CONSTRAINT "orders_paid_means_settled" CHECK ("orders"."status" <> 'PAID' OR ("orders"."paid_total" = "orders"."total" AND "orders"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"tax_id" varchar(20),
	"currency" varchar(3) DEFAULT 'RSD' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"device_id" uuid,
	"method" "payment_method" NOT NULL,
	"mode" "payment_mode" DEFAULT 'TEST' NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"tendered" numeric(14, 2),
	"change" numeric(14, 2) DEFAULT '0' NOT NULL,
	"idempotency_key" varchar(80) NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_pos" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_change_nonneg" CHECK ("payments"."change" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_price_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"old_price" numeric(14, 2),
	"new_price" numeric(14, 2) NOT NULL,
	"user_id" uuid NOT NULL,
	"changed_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"tax_rate_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"barcode" varchar(32),
	"name" text NOT NULL,
	"unit" varchar(12) DEFAULT 'kom' NOT NULL,
	"price" numeric(14, 2) NOT NULL,
	"color" varchar(16),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_price_nonneg" CHECK ("products"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"label" varchar(4) NOT NULL,
	"name" text NOT NULL,
	"rate" numeric(5, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "tax_rates_rate_range" CHECK ("tax_rates"."rate" >= 0 AND "tax_rates"."rate" < 100)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"email" text,
	"password_hash" text,
	"pin_hash" text,
	"pin_lookup" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_shift_id_cash_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."cash_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_opened_by_id_users_id_fk" FOREIGN KEY ("opened_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_voided_by_id_users_id_fk" FOREIGN KEY ("voided_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_added_by_id_users_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_id_dining_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."dining_tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_opened_by_id_users_id_fk" FOREIGN KEY ("opened_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_waiter_id_users_id_fk" FOREIGN KEY ("waiter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_shift_id_cash_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."cash_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_price_changes" ADD CONSTRAINT "product_price_changes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_price_changes" ADD CONSTRAINT "product_price_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tax_rate_id_tax_rates_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("organization_id","entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "shifts_device_status_idx" ON "cash_shifts" USING btree ("device_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_one_open_per_device_uq" ON "cash_shifts" USING btree ("device_id") WHERE "cash_shifts"."status" = 'OPEN';--> statement-breakpoint
CREATE UNIQUE INDEX "categories_org_name_uq" ON "categories" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_location_name_uq" ON "devices" USING btree ("location_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tables_location_name_uq" ON "dining_tables" USING btree ("location_id","name");--> statement-breakpoint
CREATE INDEX "locations_org_idx" ON "locations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_location_number_uq" ON "orders" USING btree ("location_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_location_idem_uq" ON "orders" USING btree ("location_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "orders_location_status_idx" ON "orders" USING btree ("location_id","status");--> statement-breakpoint
CREATE INDEX "orders_table_status_idx" ON "orders" USING btree ("table_id","status");--> statement-breakpoint
CREATE INDEX "orders_closed_at_idx" ON "orders" USING btree ("closed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_order_idem_uq" ON "payments" USING btree ("order_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "payments_shift_idx" ON "payments" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "payments_created_idx" ON "payments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ppc_product_idx" ON "product_price_changes" USING btree ("product_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "products_org_code_uq" ON "products" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "products_org_category_idx" ON "products" USING btree ("organization_id","category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_org_code_uq" ON "roles" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rates_org_label_uq" ON "tax_rates" USING btree ("organization_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_email_uq" ON "users" USING btree ("organization_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_pin_uq" ON "users" USING btree ("organization_id","pin_lookup");