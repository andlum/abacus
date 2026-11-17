CREATE TABLE "reimbursement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"date" date NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"account_id" uuid,
	"status" text DEFAULT 'recorded' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "reimbursement_status" CHECK ("reimbursement"."status" in ('recorded', 'void')),
	CONSTRAINT "reimbursement_positive" CHECK ("reimbursement"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "reimbursement" ADD CONSTRAINT "reimbursement_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement" ADD CONSTRAINT "reimbursement_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement" ADD CONSTRAINT "reimbursement_voided_by_member_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement" ADD CONSTRAINT "reimbursement_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement" ADD CONSTRAINT "reimbursement_account_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "public"."account"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reimbursement_household_member" ON "reimbursement" USING btree ("household_id","member_id") WHERE "reimbursement"."status" = 'recorded';