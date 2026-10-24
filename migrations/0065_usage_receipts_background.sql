-- Background budget class on usage receipts (#231, D-058). Owner: reasoning.
--
-- A receipt now records whether the role that made the attempt is a background role: one that runs
-- because the person read or swiped (Jev, Cartographer, Planner), not because they asked for
-- something. Admission counts background receipts separately, so background roles stop at their
-- share of the global and the personal daily caps and the rest stays for what a person asks for.
-- Derived accounting, never evidence: it is written with the receipt and never changes.
-- Queries: the budget check sums today's receipts with `background` set, globally and for one
-- universe's attempts, under the same advisory lock as the other budget sums.
-- Growth: none (one boolean per receipt). Retention and erasure are the receipt's, unchanged.
-- Rollout: additive. An older writer inserts receipts without the column and they count as
-- interactive, which is the old behaviour; an older reader ignores it.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table reasoning.usage_receipts add column background boolean not null default false;

-- Receipts of the three background roles written before this migration count against their share
-- from now on (the budget only ever reads today's window, so older rows only keep the record honest).
update reasoning.usage_receipts
set background = true
where role_id in ('composer.jev', 'geography.cartographer', 'planner.personal-planner');
