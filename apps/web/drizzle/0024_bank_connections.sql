CREATE TABLE "bank_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"access_token" text,
	"cursor" text,
	"institution_name" text NOT NULL,
	"sync_from" date NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_connection_item" UNIQUE("item_id"),
	CONSTRAINT "bank_connection_household_id" UNIQUE("household_id","id"),
	CONSTRAINT "bank_connection_status" CHECK ("bank_connection"."status" in ('ok', 'needs_relink')),
	CONSTRAINT "bank_connection_token_until_removed" CHECK (("bank_connection"."removed_at" is null) = ("bank_connection"."access_token" is not null))
);
--> statement-breakpoint
CREATE TABLE "bank_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"plaid_transaction_id" text NOT NULL,
	"date" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"description" text NOT NULL,
	"state" text DEFAULT 'to_sort' NOT NULL,
	"expense_id" uuid,
	"sorted_by" uuid,
	"sorted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transaction_plaid_id" UNIQUE("plaid_transaction_id"),
	CONSTRAINT "bank_transaction_state" CHECK ("bank_transaction"."state" in ('to_sort', 'added', 'dismissed', 'removed')),
	CONSTRAINT "bank_transaction_amount" CHECK ("bank_transaction"."amount_cents" <> 0),
	CONSTRAINT "bank_transaction_expense" CHECK (("bank_transaction"."state" = 'added') = ("bank_transaction"."expense_id" is not null)),
	CONSTRAINT "bank_transaction_spent" CHECK ("bank_transaction"."expense_id" is null or "bank_transaction"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "expense" DROP CONSTRAINT "expense_source";--> statement-breakpoint
-- Before the foreign key below that names it.
ALTER TABLE "expense" ADD CONSTRAINT "expense_household_id" UNIQUE("household_id","id");--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "bank_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "plaid_account_id" text;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "share_all" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_connection" ADD CONSTRAINT "bank_connection_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_connection" ADD CONSTRAINT "bank_connection_owner_id_member_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_sorted_by_member_id_fk" FOREIGN KEY ("sorted_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_connection_fk" FOREIGN KEY ("household_id","connection_id") REFERENCES "public"."bank_connection"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_account_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."account"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_expense_fk" FOREIGN KEY ("household_id","expense_id") REFERENCES "public"."expense"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_transaction_waiting" ON "bank_transaction" USING btree ("connection_id","date") WHERE "bank_transaction"."state" = 'to_sort';--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_bank_connection_fk" FOREIGN KEY ("household_id","bank_connection_id") REFERENCES "public"."bank_connection"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_plaid_account" UNIQUE("bank_connection_id","plaid_account_id");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_bank_link" CHECK (("account"."bank_connection_id" is null) = ("account"."plaid_account_id" is null));--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_source" CHECK ("expense"."source" in ('template', 'manual', 'import', 'agent', 'bank'));