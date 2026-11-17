ALTER TABLE "split_rule" ALTER COLUMN "change_set_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "split_rule" ADD COLUMN "supersedes_id" uuid;--> statement-breakpoint
ALTER TABLE "split_rule" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "split_rule" ADD COLUMN "voided_by" uuid;--> statement-breakpoint
ALTER TABLE "split_rule" ADD COLUMN "replaced_by" uuid;--> statement-breakpoint
ALTER TABLE "split_rule" ADD CONSTRAINT "split_rule_supersedes_id_split_rule_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."split_rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_rule" ADD CONSTRAINT "split_rule_voided_by_member_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_rule" ADD CONSTRAINT "split_rule_replaced_by_split_rule_id_fk" FOREIGN KEY ("replaced_by") REFERENCES "public"."split_rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A rule no longer waits for the others to accept it. An open change set
-- that waits only for people who have not joined (nobody who could answer)
-- takes effect: its incomes first, by the rule of migration 0020 (one its
-- owner typed, or one typed for someone who has not joined), unless the
-- owner has saved or removed an income since it was proposed.
UPDATE "income" i
SET "status" = 'active',
  "effective_from" = coalesce(i."effective_from", cs."effective_from"),
  "activated_at" = now()
FROM "change_set" cs, "member" o
WHERE i."change_set_id" = cs."id" AND o."id" = i."owner_id"
  AND i."status" = 'proposed' AND cs."status" = 'open'
  AND NOT EXISTS (
    SELECT 1 FROM "member" m
    WHERE m."household_id" = cs."household_id" AND m."linked_at" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "change_set_acceptance" a WHERE a."change_set_id" = cs."id" AND a."member_id" = m."id")
  )
  AND (i."created_by" = i."owner_id" OR o."linked_at" IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "income" r
    WHERE r."owner_id" = i."owner_id" AND r."status" IN ('active', 'void')
      AND coalesce(r."voided_at", r."created_at") > i."created_at"
  );--> statement-breakpoint
-- Then its rules, each from its own date.
UPDATE "split_rule" r
SET "status" = 'active', "activated_at" = now()
FROM "change_set" cs
WHERE r."change_set_id" = cs."id" AND r."status" = 'proposed' AND cs."status" = 'open'
  AND NOT EXISTS (
    SELECT 1 FROM "member" m
    WHERE m."household_id" = cs."household_id" AND m."linked_at" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "change_set_acceptance" a WHERE a."change_set_id" = cs."id" AND a."member_id" = m."id")
  );--> statement-breakpoint
-- And the change set is closed as accepted, on record in the audit log
-- under the member who proposed it.
WITH s AS (
  UPDATE "change_set" cs
  SET "status" = 'accepted', "closed_at" = now()
  WHERE cs."status" = 'open'
    AND NOT EXISTS (
      SELECT 1 FROM "member" m
      WHERE m."household_id" = cs."household_id" AND m."linked_at" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "change_set_acceptance" a WHERE a."change_set_id" = cs."id" AND a."member_id" = m."id")
    )
  RETURNING cs."id", cs."household_id", cs."created_by", cs."effective_from"
)
INSERT INTO "audit_log" ("household_id", "actor_kind", "actor_member_id", "action", "entity_type", "entity_id", "detail")
SELECT s."household_id", 'member', s."created_by", 'change_set.activated', 'change_set', s."id"::text,
  jsonb_build_object(
    'effectiveFrom', s."effective_from",
    'ruleIds', (SELECT coalesce(jsonb_agg(x."id" ORDER BY x."id"), '[]'::jsonb) FROM "split_rule" x WHERE x."change_set_id" = s."id" AND x."status" = 'active'),
    'incomeIds', (SELECT coalesce(jsonb_agg(x."id" ORDER BY x."id"), '[]'::jsonb) FROM "income" x WHERE x."change_set_id" = s."id" AND x."status" = 'active'),
    'by', 'migration 0021'
  )
FROM s;--> statement-breakpoint
-- Every other change set still open waited for someone who could answer:
-- it is withdrawn, with everything still waiting in it, and so is any
-- income left out above. Nothing is left waiting.
UPDATE "income" SET "status" = 'withdrawn' WHERE "status" = 'proposed';--> statement-breakpoint
UPDATE "split_rule" SET "status" = 'withdrawn' WHERE "status" = 'proposed';--> statement-breakpoint
WITH s AS (
  UPDATE "change_set" SET "status" = 'withdrawn', "closed_at" = now() WHERE "status" = 'open'
  RETURNING "id", "household_id", "created_by"
)
INSERT INTO "audit_log" ("household_id", "actor_kind", "actor_member_id", "action", "entity_type", "entity_id", "detail")
SELECT s."household_id", 'member', s."created_by", 'change_set.withdrawn', 'change_set', s."id"::text,
  jsonb_build_object(
    'ruleIds', (SELECT coalesce(jsonb_agg(x."id" ORDER BY x."id"), '[]'::jsonb) FROM "split_rule" x WHERE x."change_set_id" = s."id" AND x."status" = 'withdrawn'),
    'incomeIds', (SELECT coalesce(jsonb_agg(x."id" ORDER BY x."id"), '[]'::jsonb) FROM "income" x WHERE x."change_set_id" = s."id" AND x."status" = 'withdrawn'),
    'by', 'migration 0021'
  )
FROM s;
