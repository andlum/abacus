CREATE TABLE "card_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"plaid_transaction_id" text NOT NULL,
	"date" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"mode" text NOT NULL,
	"expense_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_payment_household_id" UNIQUE("household_id","id"),
	CONSTRAINT "card_payment_plaid_id" UNIQUE("plaid_transaction_id"),
	CONSTRAINT "card_payment_amount" CHECK ("card_payment"."amount_cents" > 0),
	CONSTRAINT "card_payment_mode" CHECK ("card_payment"."mode" in ('shared', 'personal')),
	CONSTRAINT "card_payment_personal" CHECK ("card_payment"."mode" = 'shared' or "card_payment"."expense_id" is null)
);
--> statement-breakpoint
ALTER TABLE "expense" DROP CONSTRAINT "expense_source";--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "card_mode" text;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "reviewed_through" date;--> statement-breakpoint
ALTER TABLE "bank_transaction" ADD COLUMN "card_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "card_payment" ADD CONSTRAINT "card_payment_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_payment" ADD CONSTRAINT "card_payment_account_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."account"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_payment" ADD CONSTRAINT "card_payment_expense_fk" FOREIGN KEY ("household_id","expense_id") REFERENCES "public"."expense"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_payment_expense" ON "card_payment" USING btree ("expense_id") WHERE "card_payment"."expense_id" is not null;--> statement-breakpoint
CREATE INDEX "card_payment_account_date" ON "card_payment" USING btree ("account_id","date");--> statement-breakpoint
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_card_payment_fk" FOREIGN KEY ("household_id","card_payment_id") REFERENCES "public"."card_payment"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_card_mode" CHECK ("account"."card_mode" is null or "account"."card_mode" in ('shared', 'personal'));--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_card_mode_bank" CHECK ("account"."card_mode" is null or "account"."bank_connection_id" is not null);--> statement-breakpoint
ALTER TABLE "bank_transaction" ADD CONSTRAINT "bank_transaction_card_payment" CHECK ("bank_transaction"."card_payment_id" is null or "bank_transaction"."state" = 'added');--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_source" CHECK ("expense"."source" in ('template', 'manual', 'import', 'agent', 'bank', 'card_payment'));