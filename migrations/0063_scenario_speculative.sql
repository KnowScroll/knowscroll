-- Speculative branches (#244, D-049 addendum). Owner: scenarios.
-- scenarios.nodes gains `speculative`: the Planner said the branch's premise contradicts established knowledge and
-- the member confirmed it (an edit of that direction keeps the flag), or the branch continues one that did. The
-- client says so in words on the card, over the Scroll and in the map; it is a fact about the premise, not a second
-- status label. Written once, when the branch is made (inherited from the parent unless the step itself is
-- speculative); never changed afterwards. Only a hypothetical branch can be speculative: every what-if is, and so
-- is everything below one. Queries: read with the node, never filtered on. Growth: none beyond the node's own row.
-- Retention and erasure are the node's, unchanged. Rollout: additive with a default; an older writer leaves it
-- false and an older reader ignores it.
--
-- Backfill (best effort). Branches made before this column existed, from a direction the Planner marked
-- `needsConfirmation` and chosen as it stood, were meant to carry the notice. They are found through the draft
-- that made them: a draft's chosen node, where an option of that draft was marked and its changes equal the node's.
-- Everything below such a branch is then marked too. What it cannot recover: a draft erased by Clear (or by the
-- account's deletion) is gone, so a branch made from it stays unmarked, and an edited direction whose changes were
-- not touched is marked although part 1 did not mark it. The statements between the markers are what the
-- integration test runs against rows seeded as part 1 wrote them.
--
-- Semantic keys. A branch's meaning (and so its `semantic_key`) now includes whether it is speculative and which
-- premises it takes over. The keys of branches made before this change were hashed the old way and are not
-- recomputed, so asking again for an idea that already has such a branch makes one extra branch (one extra Create),
-- once, instead of reusing it. Nothing is merged or lost; the old branch stays as it is.
-- (Provisional number: the coordinator assigns the final one.)
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table scenarios.nodes add column speculative boolean not null default false;

-- backfill:begin
update scenarios.nodes as node
set speculative = true
from scenarios.drafts as draft, jsonb_array_elements(draft.options) as option
where draft.node_id = node.node_id
  and node.kind = 'what_if'
  and option ->> 'needsConfirmation' = 'true'
  and option -> 'changes' = node.changes;

with recursive below(node_id) as (
  select node_id from scenarios.nodes where speculative
  union
  select child.node_id from scenarios.nodes as child join below on child.parent_node_id = below.node_id
)
update scenarios.nodes
set speculative = true
where node_id in (select node_id from below) and not speculative;
-- backfill:end

alter table scenarios.nodes
  add constraint nodes_speculative_is_hypothetical check (not speculative or hypothetical) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table scenarios.nodes validate constraint nodes_speculative_is_hypothetical;
