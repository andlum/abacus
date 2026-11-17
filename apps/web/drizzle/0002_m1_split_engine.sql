CREATE TABLE "change_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"preview" jsonb,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "change_set_status" CHECK ("change_set"."status" in ('open', 'accepted', 'rejected', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "change_set_acceptance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"change_set_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_set_acceptance_once" UNIQUE("change_set_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "expense" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"template_id" uuid,
	"template_lineage_id" uuid,
	"period" text,
	"date" date NOT NULL,
	"description" text NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"total_cents" bigint,
	"payer_id" uuid NOT NULL,
	"rule_source" text,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"computation" jsonb,
	"unassigned_reason" text,
	"chosen_rule" jsonb,
	"supersedes_id" uuid,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "expense_status" CHECK ("expense"."status" in ('posted', 'unassigned', 'needs_amount', 'superseded', 'void')),
	CONSTRAINT "expense_source" CHECK ("expense"."source" in ('template', 'manual', 'import')),
	CONSTRAINT "expense_total" CHECK ("expense"."total_cents" is null or "expense"."total_cents" > 0),
	CONSTRAINT "expense_total_present" CHECK ("expense"."status" = 'needs_amount' or "expense"."total_cents" is not null),
	CONSTRAINT "expense_template_period" CHECK (("expense"."template_lineage_id" is null) = ("expense"."period" is null))
);
--> statement-breakpoint
CREATE TABLE "expense_share" (
	"expense_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"share_cents" bigint NOT NULL,
	CONSTRAINT "expense_share_expense_id_member_id_pk" PRIMARY KEY("expense_id","member_id"),
	CONSTRAINT "expense_share_non_negative" CHECK ("expense_share"."share_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "expense_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"lineage_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"amount_cents" bigint,
	"cadence" text NOT NULL,
	"day_of_month" integer NOT NULL,
	"month_of_year" integer,
	"payer_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"effective_from" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"supersedes_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "expense_template_cadence" CHECK ("expense_template"."cadence" in ('monthly', 'yearly')),
	CONSTRAINT "expense_template_status" CHECK ("expense_template"."status" in ('active', 'superseded')),
	CONSTRAINT "expense_template_day" CHECK ("expense_template"."day_of_month" between 1 and 31),
	CONSTRAINT "expense_template_month" CHECK (("expense_template"."cadence" = 'yearly' and "expense_template"."month_of_year" between 1 and 12) or ("expense_template"."cadence" = 'monthly' and "expense_template"."month_of_year" is null)),
	CONSTRAINT "expense_template_amount" CHECK ("expense_template"."amount_cents" is null or "expense_template"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"file_hash" text NOT NULL,
	"row_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "income" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"annual_cents" bigint NOT NULL,
	"effective_from" date,
	"share_mode" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"change_set_id" uuid,
	"supersedes_id" uuid,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "income_status" CHECK ("income"."status" in ('proposed', 'active', 'rejected', 'withdrawn', 'void')),
	CONSTRAINT "income_share_mode" CHECK ("income"."share_mode" in ('amount', 'ratio_only')),
	CONSTRAINT "income_non_negative" CHECK ("income"."annual_cents" >= 0),
	CONSTRAINT "income_active_has_date" CHECK ("income"."status" <> 'active' or "income"."effective_from" is not null)
);
--> statement-breakpoint
CREATE TABLE "settlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"from_member_id" uuid NOT NULL,
	"to_member_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"date" date NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'recorded' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "settlement_status" CHECK ("settlement"."status" in ('recorded', 'void')),
	CONSTRAINT "settlement_positive" CHECK ("settlement"."amount_cents" > 0),
	CONSTRAINT "settlement_two_people" CHECK ("settlement"."from_member_id" <> "settlement"."to_member_id")
);
--> statement-breakpoint
CREATE TABLE "split_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"template_lineage_id" uuid,
	"category" text,
	"rule" jsonb NOT NULL,
	"effective_from" date NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"change_set_id" uuid NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "split_rule_status" CHECK ("split_rule"."status" in ('proposed', 'active', 'rejected', 'withdrawn', 'void')),
	CONSTRAINT "split_rule_one_scope" CHECK (("split_rule"."scope" = 'template' and "split_rule"."template_lineage_id" is not null and "split_rule"."category" is null)
        or ("split_rule"."scope" = 'category' and "split_rule"."template_lineage_id" is null and "split_rule"."category" is not null)
        or ("split_rule"."scope" = 'household' and "split_rule"."template_lineage_id" is null and "split_rule"."category" is null))
);
--> statement-breakpoint
ALTER TABLE "household" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "change_set" ADD CONSTRAINT "change_set_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_set" ADD CONSTRAINT "change_set_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_set_acceptance" ADD CONSTRAINT "change_set_acceptance_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_set_acceptance" ADD CONSTRAINT "change_set_acceptance_change_set_id_change_set_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_set"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_set_acceptance" ADD CONSTRAINT "change_set_acceptance_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_template_id_expense_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."expense_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_payer_id_member_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_supersedes_id_expense_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."expense"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_import_batch_id_import_batch_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_share" ADD CONSTRAINT "expense_share_expense_id_expense_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expense"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_share" ADD CONSTRAINT "expense_share_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_share" ADD CONSTRAINT "expense_share_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_template" ADD CONSTRAINT "expense_template_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_template" ADD CONSTRAINT "expense_template_payer_id_member_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_template" ADD CONSTRAINT "expense_template_supersedes_id_expense_template_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."expense_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_template" ADD CONSTRAINT "expense_template_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income" ADD CONSTRAINT "income_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income" ADD CONSTRAINT "income_owner_id_member_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income" ADD CONSTRAINT "income_change_set_id_change_set_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_set"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income" ADD CONSTRAINT "income_supersedes_id_income_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."income"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income" ADD CONSTRAINT "income_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_from_member_id_member_id_fk" FOREIGN KEY ("from_member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_to_member_id_member_id_fk" FOREIGN KEY ("to_member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_voided_by_member_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_rule" ADD CONSTRAINT "split_rule_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_rule" ADD CONSTRAINT "split_rule_change_set_id_change_set_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_set"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_rule" ADD CONSTRAINT "split_rule_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_one_live_per_period" ON "expense" USING btree ("template_lineage_id","period") WHERE "expense"."status" in ('posted', 'unassigned', 'needs_amount');--> statement-breakpoint
CREATE INDEX "expense_household_date" ON "expense" USING btree ("household_id","date");--> statement-breakpoint
CREATE INDEX "expense_template_lineage" ON "expense_template" USING btree ("household_id","lineage_id");--> statement-breakpoint
CREATE INDEX "income_household_owner" ON "income" USING btree ("household_id","owner_id");--> statement-breakpoint
CREATE INDEX "split_rule_household" ON "split_rule" USING btree ("household_id","status");