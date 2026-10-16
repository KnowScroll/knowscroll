-- #199: a world's own live cap may now be raised to 700 cents, the owner's $7 for dev and stage
-- together (2026-10-09). The value itself stays where an operator sets it (`set-live-cap`); only the
-- ceiling on it moves, so it remains a second lock behind the shared pool.
ALTER TABLE generation_live_cap
 DROP CONSTRAINT generation_live_cap_cap_cents_check,
 ADD CONSTRAINT generation_live_cap_cap_cents_check CHECK (cap_cents BETWEEN 0 AND 700);
