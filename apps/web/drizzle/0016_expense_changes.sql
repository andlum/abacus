CREATE TABLE "expense_change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"date" date,
	"description" text,
	"category" text,
	"total_cents" bigint,
	"payer_id" uuid,
	"reason" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposal_request_id" uuid NOT NULL,
	"result_expense_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	CONSTRAINT "expense_change_kind" CHECK ("expense_change"."kind" in ('correction', 'void')),
	CONSTRAINT "expense_change_status" CHECK ("expense_change"."status" in ('proposed', 'confirmed', 'rejected', 'stale')),
	CONSTRAINT "expense_change_correction_values" CHECK ("expense_change"."kind" <> 'correction' or ("expense_change"."date" is not null and "expense_change"."description" is not null and "expense_change"."category" is not null and "expense_change"."total_cents" is not null and "expense_change"."payer_id" is not null)),
	CONSTRAINT "expense_change_void_values" CHECK ("expense_change"."kind" <> 'void' or ("expense_change"."reason" is not null and "expense_change"."date" is null and "expense_change"."description" is null and "expense_change"."category" is null and "expense_change"."total_cents" is null and "expense_change"."payer_id" is null)),
	CONSTRAINT "expense_change_total" CHECK ("expense_change"."total_cents" is null or "expense_change"."total_cents" > 0),
	CONSTRAINT "expense_change_reason_length" CHECK ("expense_change"."reason" is null or length("expense_change"."reason") <= 500),
	CONSTRAINT "expense_change_decided" CHECK (("expense_change"."status" = 'proposed') = ("expense_change"."decided_at" is null)),
	CONSTRAINT "expense_change_result" CHECK ("expense_change"."result_expense_id" is null or ("expense_change"."kind" = 'correction' and "expense_change"."status" = 'confirmed'))
);
--> statement-breakpoint
ALTER TABLE "expense_change" ADD CONSTRAINT "expense_change_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_change" ADD CONSTRAINT "expense_change_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_change" ADD CONSTRAINT "expense_change_expense_id_expense_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expense"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_change" ADD CONSTRAINT "expense_change_payer_id_member_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_change" ADD CONSTRAINT "expense_change_proposal_request_id_proposal_request_id_fk" FOREIGN KEY ("proposal_request_id") REFERENCES "public"."proposal_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_change" ADD CONSTRAINT "expense_change_result_expense_id_expense_id_fk" FOREIGN KEY ("result_expense_id") REFERENCES "public"."expense"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_change" ADD CONSTRAINT "expense_change_decided_by_member_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_change" ADD CONSTRAINT "expense_change_category_fk" FOREIGN KEY ("household_id","category") REFERENCES "public"."category"("household_id","slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_change_waiting" ON "expense_change" USING btree ("household_id","member_id") WHERE "expense_change"."status" = 'proposed';--> statement-breakpoint
CREATE UNIQUE INDEX "expense_change_one_waiting" ON "expense_change" USING btree ("expense_id","member_id") WHERE "expense_change"."status" = 'proposed';--> statement-breakpoint
CREATE INDEX "expense_change_request" ON "expense_change" USING btree ("proposal_request_id");