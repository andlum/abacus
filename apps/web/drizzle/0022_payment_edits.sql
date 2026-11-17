ALTER TABLE "settlement" ADD COLUMN "supersedes_id" uuid;--> statement-breakpoint
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_supersedes_id_settlement_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."settlement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_supersedes" ON "settlement" USING btree ("supersedes_id");