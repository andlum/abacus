ALTER TABLE "member" RENAME COLUMN "clerk_user_id" TO "auth_user_id";--> statement-breakpoint
ALTER TABLE "member" DROP CONSTRAINT "member_clerk_user_id_unique";--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_auth_user_id_unique" UNIQUE("auth_user_id");