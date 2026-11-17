ALTER TABLE "expense" DROP CONSTRAINT "expense_status";--> statement-breakpoint
ALTER TABLE "expense" DROP CONSTRAINT "expense_source";--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_status" CHECK ("expense"."status" in ('posted', 'unassigned', 'needs_amount', 'superseded', 'void', 'proposed', 'rejected'));--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_source" CHECK ("expense"."source" in ('template', 'manual', 'import', 'agent'));