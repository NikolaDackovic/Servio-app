ALTER TABLE "prep_stations" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "roles" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['shift.manage','day.manage','report.read']::text[])) WHERE "code" IN ('WAITER','BARTENDER');
