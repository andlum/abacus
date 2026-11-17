DROP INDEX "expense_household_date";--> statement-breakpoint
CREATE INDEX "expense_household_order" ON "expense" USING btree ("household_id","date","created_at","id");