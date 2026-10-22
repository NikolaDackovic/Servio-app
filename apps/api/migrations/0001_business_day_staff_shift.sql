CREATE TYPE "public"."business_day_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."staff_shift_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TABLE "business_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"date" date NOT NULL,
	"status" "business_day_status" DEFAULT 'OPEN' NOT NULL,
	"opened_by_id" uuid NOT NULL,
	"closed_by_id" uuid,
	"opened_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp (3) with time zone,
	"summary" jsonb,
	CONSTRAINT "business_days_closed_consistent" CHECK ("business_days"."status" <> 'CLOSED' OR ("business_days"."closed_at" IS NOT NULL AND "business_days"."closed_by_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "staff_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"business_day_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "staff_shift_status" DEFAULT 'OPEN' NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp (3) with time zone,
	"ended_by_id" uuid,
	"summary" jsonb
);
--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD COLUMN "business_day_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "business_day_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "business_day_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "staff_shift_id" uuid;--> statement-breakpoint
ALTER TABLE "business_days" ADD CONSTRAINT "business_days_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_days" ADD CONSTRAINT "business_days_opened_by_id_users_id_fk" FOREIGN KEY ("opened_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_days" ADD CONSTRAINT "business_days_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_shifts" ADD CONSTRAINT "staff_shifts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_shifts" ADD CONSTRAINT "staff_shifts_business_day_id_business_days_id_fk" FOREIGN KEY ("business_day_id") REFERENCES "public"."business_days"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_shifts" ADD CONSTRAINT "staff_shifts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_shifts" ADD CONSTRAINT "staff_shifts_ended_by_id_users_id_fk" FOREIGN KEY ("ended_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_days_location_date_uq" ON "business_days" USING btree ("location_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "business_days_one_open_uq" ON "business_days" USING btree ("location_id") WHERE "business_days"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "staff_shifts_day_idx" ON "staff_shifts" USING btree ("business_day_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_shifts_one_open_uq" ON "staff_shifts" USING btree ("location_id","user_id") WHERE "staff_shifts"."status" = 'OPEN';--> statement-breakpoint
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_business_day_id_business_days_id_fk" FOREIGN KEY ("business_day_id") REFERENCES "public"."business_days"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_business_day_id_business_days_id_fk" FOREIGN KEY ("business_day_id") REFERENCES "public"."business_days"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_business_day_id_business_days_id_fk" FOREIGN KEY ("business_day_id") REFERENCES "public"."business_days"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_staff_shift_id_staff_shifts_id_fk" FOREIGN KEY ("staff_shift_id") REFERENCES "public"."staff_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_business_day_idx" ON "orders" USING btree ("business_day_id");--> statement-breakpoint
CREATE INDEX "payments_business_day_idx" ON "payments" USING btree ("business_day_id");--> statement-breakpoint
-- Novo pravo: upravljanje poslovnim danom (otvaranje / zaključak). Dodaje se postojećim ulogama.
UPDATE "roles" SET "permissions" = array_append("permissions", 'day.manage')
WHERE "code" IN ('ADMIN', 'OWNER', 'MANAGER', 'CASHIER') AND NOT ('day.manage' = ANY("permissions"));
