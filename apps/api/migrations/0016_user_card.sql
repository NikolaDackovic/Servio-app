ALTER TABLE "users" ADD COLUMN "card_lookup" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_card_uq" ON "users" ("organization_id", "card_lookup") WHERE "card_lookup" IS NOT NULL;
