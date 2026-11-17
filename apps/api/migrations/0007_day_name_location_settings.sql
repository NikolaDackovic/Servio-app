DROP INDEX "business_days_location_date_uq";--> statement-breakpoint
ALTER TABLE "business_days" ADD COLUMN "name" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "business_days" SET "name" = (ARRAY['Nedelja','Ponedeljak','Utorak','Sreda','Četvrtak','Petak','Subota'])[extract(dow from "date")::int + 1];--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "business_days_location_date_name_uq" ON "business_days" USING btree ("location_id","date","name");