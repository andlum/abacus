ALTER TABLE "member" DROP CONSTRAINT "member_email_unique";--> statement-breakpoint
ALTER TABLE "member" DROP CONSTRAINT "member_auth_user_id_unique";--> statement-breakpoint
ALTER TABLE "household" ADD COLUMN "kind" text DEFAULT 'household' NOT NULL;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "member_one_default" ON "member" USING btree ("auth_user_id") WHERE "member"."is_default";--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_household_email" UNIQUE("household_id","email");--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_household_auth_user" UNIQUE("household_id","auth_user_id");