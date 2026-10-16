-- #199: the owner raised the shared Reel budget from $5 to $7 for dev and stage together
-- (2026-10-09, in chat, choosing "$7 total" with $2.78 left on fal). The cap row and its CHECK move
-- together, so the column still refuses anything above what the owner allowed.
ALTER TABLE pool_budget
 DROP CONSTRAINT pool_budget_cap_cents_check,
 ADD CONSTRAINT pool_budget_cap_cents_check CHECK (cap_cents BETWEEN 0 AND 700);
UPDATE pool_budget
 SET cap_cents = 700,
  set_by = 'owner decision 2026-10-09 (#199): $7 total for dev and stage',
  set_at = clock_timestamp();
