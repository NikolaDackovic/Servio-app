ALTER TABLE "dining_tables" ADD COLUMN "qr_token" varchar(24) DEFAULT substr(md5(random()::text || clock_timestamp()::text), 1, 20) NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "dining_tables_qr_token_uq" ON "dining_tables" ("qr_token");
