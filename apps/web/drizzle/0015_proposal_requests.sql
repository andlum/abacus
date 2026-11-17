CREATE TABLE "proposal_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mcp_token_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_request_key_once" UNIQUE("mcp_token_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "proposal_request_id" uuid;--> statement-breakpoint
ALTER TABLE "proposal_request" ADD CONSTRAINT "proposal_request_mcp_token_id_mcp_token_id_fk" FOREIGN KEY ("mcp_token_id") REFERENCES "public"."mcp_token"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_request" ADD CONSTRAINT "proposal_request_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_request" ADD CONSTRAINT "proposal_request_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_proposal_request_id_proposal_request_id_fk" FOREIGN KEY ("proposal_request_id") REFERENCES "public"."proposal_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_proposal_request" ON "expense" USING btree ("proposal_request_id") WHERE "expense"."proposal_request_id" is not null;