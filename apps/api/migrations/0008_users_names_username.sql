ALTER TABLE "users" ADD COLUMN "first_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" varchar(40);--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_username_uq" ON "users" USING btree ("organization_id","username");--> statement-breakpoint
UPDATE "users" SET "first_name" = split_part("full_name", ' ', 1), "last_name" = trim(substr("full_name", length(split_part("full_name", ' ', 1)) + 1));--> statement-breakpoint
UPDATE "users" SET "username" = lower(split_part("email", '@', 1)) WHERE "email" IS NOT NULL;--> statement-breakpoint
UPDATE "roles" SET "permissions" = array_append("permissions", 'order.split') WHERE 'order.write' = ANY("permissions") AND NOT ('order.split' = ANY("permissions"));
