-- Adding the columns rewrites nothing: they are nullable with no default.
-- Adding the two foreign keys briefly blocks writes to expense and
-- expense_template while Postgres validates the new column, which is null on
-- every existing row, so the check is quick. Building the new index also
-- blocks writes to expense while it reads the table once.
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"last_four" text,
	"kind" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "account_household_id" UNIQUE("household_id","id"),
	CONSTRAINT "account_name_present" CHECK (length(trim("account"."name")) > 0),
	CONSTRAINT "account_last_four" CHECK ("account"."last_four" is null or "account"."last_four" ~ '^[0-9]{4}$'),
	CONSTRAINT "account_kind" CHECK ("account"."kind" is null or "account"."kind" in ('personal', 'business'))
);
--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "expense_template" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_live_name" ON "account" USING btree ("household_id",lower("name")) WHERE "account"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_account_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."account"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_template" ADD CONSTRAINT "expense_template_account_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."account"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_household_account" ON "expense" USING btree ("household_id","account_id") WHERE "expense"."account_id" is not null;