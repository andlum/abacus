CREATE TABLE "mcp_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"permission" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "mcp_token_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "mcp_token_permission" CHECK ("mcp_token"."permission" in ('read', 'propose'))
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_token_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_token" ADD CONSTRAINT "mcp_token_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_token" ADD CONSTRAINT "mcp_token_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_token_id_mcp_token_id_fk" FOREIGN KEY ("actor_token_id") REFERENCES "public"."mcp_token"("id") ON DELETE no action ON UPDATE no action;