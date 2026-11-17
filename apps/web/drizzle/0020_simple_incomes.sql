ALTER TABLE "income" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "income" ADD COLUMN "voided_by" uuid;--> statement-breakpoint
ALTER TABLE "income" ADD COLUMN "replaced_by" uuid;--> statement-breakpoint
ALTER TABLE "income" ADD CONSTRAINT "income_voided_by_member_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income" ADD CONSTRAINT "income_replaced_by_income_id_fk" FOREIGN KEY ("replaced_by") REFERENCES "public"."income"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- An income no longer waits for a change set. For each owner, the newest one
-- saved and still waiting outside any change set takes effect now, from the
-- day it was recorded, if it is one the new rules would have let its author
-- save: their own, or one typed for someone who has not joined yet.
WITH "newest" AS (
  SELECT DISTINCT ON (i."owner_id") i."id"
  FROM "income" i
  JOIN "member" m ON m."id" = i."owner_id"
  WHERE i."status" = 'proposed' AND i."change_set_id" IS NULL
    AND (i."created_by" = i."owner_id" OR m."linked_at" IS NULL)
  ORDER BY i."owner_id", i."created_at" DESC, i."id" DESC
)
UPDATE "income"
SET "status" = 'active',
  "effective_from" = coalesce("effective_from", "created_at"::date),
  "activated_at" = now()
WHERE "id" IN (SELECT "id" FROM "newest");--> statement-breakpoint
-- Every other one still waiting outside a change set is withdrawn. Rows
-- already in a change set are left to that change set.
UPDATE "income"
SET "status" = 'withdrawn'
WHERE "status" = 'proposed' AND "change_set_id" IS NULL;
