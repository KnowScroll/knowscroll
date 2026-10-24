-- #240, D-030 (owner, 2026-10-23): up to $4 (400 cents) of new spend on v2 Reels, on top of the
-- 617 cents already settled by the v1 orders, shared by dev and stage. The cap rule itself does not
-- change (`pool_order_cap_guard`: settled spend plus every open ceiling stays within the cap); the
-- cap and its CHECK move together, so the column still refuses anything beyond what the owner allowed.
--
-- Written for exactly the state the owner saw: cap 700, 617 cents committed, nothing open (an open
-- claim counts its ceiling, so it would change the figure). A pool in any other state refuses this
-- migration instead of quietly turning "400 more" into some other figure. The table is locked first,
-- in the mode every claim takes, so no claim can slip in between the check and the change. It is a
-- new migration; 0001 and 0002 stay as they were applied.
LOCK TABLE pool_order IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
 IF (SELECT cap_cents FROM pool_budget) <> 700 THEN
  RAISE EXCEPTION 'The pool cap is not the 700 cents this migration was written for';
 END IF;
 IF pool_committed_cents() <> 617 THEN
  RAISE EXCEPTION 'The committed spend is not the 617 cents the owner saw; the 400-cent allowance needs a new decision';
 END IF;
END $$;

ALTER TABLE pool_budget
 DROP CONSTRAINT pool_budget_cap_cents_check,
 ADD CONSTRAINT pool_budget_cap_cents_check CHECK (cap_cents BETWEEN 0 AND 1017);
UPDATE pool_budget
 SET cap_cents = 1017,
  set_by = 'owner decision 2026-10-23 (D-030): $4 of new Reel spend on top of 617 cents settled',
  set_at = clock_timestamp();
