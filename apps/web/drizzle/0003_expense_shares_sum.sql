-- Custom SQL migration file, put your code below! --
-- A posted expense's shares sum exactly to its total. Checked when the
-- transaction commits, so the expense and its shares can be written in any
-- order inside one transaction.
CREATE FUNCTION expense_shares_must_sum() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  eid uuid;
  e record;
  share_sum bigint;
BEGIN
  IF TG_TABLE_NAME = 'expense' THEN
    eid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    eid := OLD.expense_id;
  ELSE
    eid := NEW.expense_id;
  END IF;
  SELECT status, total_cents INTO e FROM expense WHERE id = eid;
  IF NOT FOUND OR e.status <> 'posted' THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(SUM(share_cents), 0) INTO share_sum FROM expense_share WHERE expense_id = eid;
  IF share_sum <> e.total_cents THEN
    RAISE EXCEPTION 'expense % is posted but its shares sum to % of %', eid, share_sum, e.total_cents;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER expense_shares_sum_on_expense
  AFTER INSERT OR UPDATE ON "expense"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION expense_shares_must_sum();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER expense_shares_sum_on_share
  AFTER INSERT OR UPDATE OR DELETE ON "expense_share"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION expense_shares_must_sum();
