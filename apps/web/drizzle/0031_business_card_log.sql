CREATE TABLE "merchant_category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"merchant_key" text NOT NULL,
	"category" text NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_category_household_merchant" UNIQUE("household_id","merchant_key"),
	CONSTRAINT "merchant_category_key_present" CHECK (length("merchant_category"."merchant_key") > 0)
);
--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "tax_line" text;--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "half_deductible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "vendor" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "business_use_bp" integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "use_basis" text;--> statement-breakpoint
ALTER TABLE "merchant_category" ADD CONSTRAINT "merchant_category_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_category" ADD CONSTRAINT "merchant_category_category_fk" FOREIGN KEY ("household_id","category") REFERENCES "public"."category"("household_id","slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_tax_line_present" CHECK ("category"."tax_line" is null or length(trim("category"."tax_line")) > 0);--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_business_use" CHECK ("expense"."business_use_bp" between 1 and 10000);--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_use_basis" CHECK ("expense"."business_use_bp" = 10000 or length(trim("expense"."use_basis")) > 0);