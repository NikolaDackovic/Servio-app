CREATE TABLE "happy_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date NOT NULL,
	"time_from" varchar(5) NOT NULL,
	"time_to" varchar(5) NOT NULL,
	"weekdays" integer[] DEFAULT '{}'::int[] NOT NULL,
	"category_id" uuid,
	"product_id" uuid,
	"kind" varchar(8) DEFAULT 'PRICE' NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "happy_hours_kind" CHECK ("happy_hours"."kind" IN ('PRICE', 'PERCENT')),
	CONSTRAINT "happy_hours_target" CHECK ("happy_hours"."category_id" IS NOT NULL OR "happy_hours"."product_id" IS NOT NULL),
	CONSTRAINT "happy_hours_value" CHECK ("happy_hours"."value" >= 0 AND ("happy_hours"."kind" <> 'PERCENT' OR "happy_hours"."value" <= 100))
);
--> statement-breakpoint
CREATE TABLE "price_list_items" (
	"price_list_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"price" numeric(14, 2) NOT NULL,
	CONSTRAINT "price_list_items_price_list_id_product_id_pk" PRIMARY KEY("price_list_id","product_id"),
	CONSTRAINT "price_list_items_price_nonneg" CHECK ("price_list_items"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "price_list_id" uuid;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "color" varchar(16);--> statement-breakpoint
ALTER TABLE "happy_hours" ADD CONSTRAINT "happy_hours_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "happy_hours" ADD CONSTRAINT "happy_hours_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "happy_hours" ADD CONSTRAINT "happy_hours_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_org_name_uq" ON "price_lists" USING btree ("organization_id","name");