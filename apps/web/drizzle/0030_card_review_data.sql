-- Custom SQL migration file, put your code below! --
-- Card review (docs/specs/2026-11-27-card-review.md).
--
-- The purchases taken out of one shared card payment never add up to more
-- than it. Checked when the transaction commits, so a review can write the
-- purchases and the payment's new expense in any order.
CREATE FUNCTION card_payment_purchases_within() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pid uuid;
  paid bigint;
  taken bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    pid := OLD.card_payment_id;
  ELSE
    pid := NEW.card_payment_id;
  END IF;
  IF pid IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT amount_cents INTO paid FROM card_payment WHERE id = pid;
  SELECT COALESCE(SUM(amount_cents), 0) INTO taken
    FROM bank_transaction WHERE card_payment_id = pid AND state = 'added';
  IF taken > paid THEN
    RAISE EXCEPTION 'purchases taken out of card payment % add up to % of %', pid, taken, paid;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER card_payment_purchases_within
  AFTER INSERT OR UPDATE ON "bank_transaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION card_payment_purchases_within();
--> statement-breakpoint
-- Cards connected before card review start as personal, so nothing is
-- shared without its owner saying so.
UPDATE "account" SET "card_mode" = 'personal' WHERE "bank_connection_id" IS NOT NULL;
--> statement-breakpoint
-- Card purchases waiting in To sort are cleared: a review reads them fresh
-- from Plaid. A card that still shares everything keeps its own.
WITH t AS (
  UPDATE "bank_transaction" b SET "state" = 'dismissed'
  FROM "account" a
  WHERE b."account_id" = a."id" AND b."state" = 'to_sort' AND NOT a."share_all"
  RETURNING b."id", b."household_id"
)
INSERT INTO "audit_log" ("household_id", "actor_kind", "action", "entity_type", "entity_id", "detail")
SELECT t."household_id", 'system', 'bank_transaction.cleared_for_review', 'bank_transaction', t."id"::text,
  jsonb_build_object('by', 'migration 0030')
FROM t;
