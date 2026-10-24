-- Speculative branches (#244, D-049 addendum). Owner: scenarios.
-- scenarios.nodes gains `speculative`: the Planner marked the branch's premise as running against established
-- knowledge and the member confirmed it, or the branch continues one that did. The client says so in words on
-- the card, over the Scroll and in the map; it is a fact about the premise, not a second status label.
-- Written once, when the branch is made (inherited from the parent unless the step itself is speculative);
-- never changed afterwards. Queries: read with the node, never filtered on. Growth: none beyond the node's
-- own row. Retention and erasure are the node's, unchanged. Rollout: additive with a default; an older
-- writer leaves it false and an older reader ignores it.
-- (Provisional number: the coordinator assigns the final one.)
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table scenarios.nodes add column speculative boolean not null default false;
