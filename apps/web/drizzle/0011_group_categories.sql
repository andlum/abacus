CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "category_household_slug" UNIQUE("household_id","slug"),
	CONSTRAINT "category_slug_shape" CHECK ("category"."slug" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
	CONSTRAINT "category_label_present" CHECK (length(trim("category"."label")) > 0),
	CONSTRAINT "category_other_stays" CHECK ("category"."slug" <> 'other' or "category"."archived_at" is null)
);
--> statement-breakpoint
ALTER TABLE "expense" DROP CONSTRAINT "expense_category";--> statement-breakpoint
ALTER TABLE "expense_template" DROP CONSTRAINT "expense_template_category";--> statement-breakpoint
ALTER TABLE "split_rule" DROP CONSTRAINT "split_rule_category";--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Groups that exist keep what they could already use. A household keeps the
-- fixed list it had. A business gets the business starting list, plus any
-- category from the old list that one of its costs, recurring costs or rules
-- names. These lists are a copy made on the day of this migration; new groups
-- are seeded from DEFAULT_CATEGORIES in src/lib/categories.ts.
CREATE TEMPORARY TABLE "old_category" ("slug" text PRIMARY KEY, "label" text NOT NULL);--> statement-breakpoint
INSERT INTO "old_category" ("slug", "label") VALUES
	('housing', 'Housing'), ('utilities', 'Utilities'), ('groceries', 'Groceries'), ('dining', 'Dining out'),
	('transport', 'Transport'), ('health', 'Health'), ('insurance', 'Insurance'), ('household', 'Household'),
	('childcare', 'Childcare'), ('pets', 'Pets'), ('travel', 'Travel'), ('entertainment', 'Entertainment'),
	('subscriptions', 'Subscriptions'), ('gifts', 'Gifts'), ('other', 'Other');--> statement-breakpoint
INSERT INTO "category" ("household_id", "slug", "label")
SELECT h."id", o."slug", o."label" FROM "household" h CROSS JOIN "old_category" o WHERE h."kind" = 'household';--> statement-breakpoint
INSERT INTO "category" ("household_id", "slug", "label")
SELECT h."id", b."slug", b."label" FROM "household" h CROSS JOIN (VALUES
	('software', 'Software'), ('contractors', 'Contractors'), ('advertising', 'Advertising'), ('office', 'Office'),
	('travel', 'Travel'), ('meals', 'Meals'), ('fees', 'Fees'), ('other', 'Other')
) AS b("slug", "label") WHERE h."kind" = 'business';--> statement-breakpoint
INSERT INTO "category" ("household_id", "slug", "label")
SELECT u."household_id", o."slug", o."label" FROM (
	SELECT "household_id", "category" FROM "expense"
	UNION SELECT "household_id", "category" FROM "expense_template"
	UNION SELECT "household_id", "category" FROM "split_rule" WHERE "category" IS NOT NULL
) u JOIN "old_category" o ON o."slug" = u."category"
ON CONFLICT ("household_id", "slug") DO NOTHING;--> statement-breakpoint
DROP TABLE "old_category";--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_category_fk" FOREIGN KEY ("household_id","category") REFERENCES "public"."category"("household_id","slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_template" ADD CONSTRAINT "expense_template_category_fk" FOREIGN KEY ("household_id","category") REFERENCES "public"."category"("household_id","slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_rule" ADD CONSTRAINT "split_rule_category_fk" FOREIGN KEY ("household_id","category") REFERENCES "public"."category"("household_id","slug") ON DELETE no action ON UPDATE no action;