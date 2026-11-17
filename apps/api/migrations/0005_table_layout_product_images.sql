CREATE TABLE "product_images" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"mime" varchar(32) NOT NULL,
	"data" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_images_mime" CHECK ("product_images"."mime" IN ('image/png', 'image/jpeg', 'image/webp'))
);
--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "width" integer DEFAULT 110 NOT NULL;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "height" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "shape" varchar(8) DEFAULT 'RECT' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD CONSTRAINT "tables_shape_valid" CHECK ("dining_tables"."shape" IN ('RECT', 'ROUND'));--> statement-breakpoint
ALTER TABLE "dining_tables" ADD CONSTRAINT "tables_size_range" CHECK ("dining_tables"."width" BETWEEN 40 AND 600 AND "dining_tables"."height" BETWEEN 40 AND 600);