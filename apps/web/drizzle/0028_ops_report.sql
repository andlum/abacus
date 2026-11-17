CREATE TABLE "ops_report" (
	"day" date PRIMARY KEY NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"counts" jsonb,
	"claimed_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone
);
