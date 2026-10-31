-- #486 Scenarios: the short answer card of a what-if branch (D-211, D-212).
--
-- Owner: scenarios. Authoritative.
-- A what-if branch gets a short answer about 30 seconds after it is chosen, while its full Scroll is still being
-- made. The answer is a property of the branch (one per what-if node), so it sits on the node's own row: it is
-- shared work of the thread exactly as the node is, it names no person, and it needs no table of its own.
--
-- `answer_state`: `making` (a worker is writing it), `ready` (it passed the card's checks) or `unavailable` (there
-- will be none: no source to cite, a failed or refused answer, or too long a wait). Null for a perspective, for a
-- branch made before this migration (nothing is invented for it) and for a removed branch.
-- `answer`: the checked card, `scenario-answer.v1`: the assumption line, claims each with the IDs of the claims of
-- the Scroll's provenance they cite, and the figures a source states. Backend-only; the thread is served the
-- assumption, the claims' text joined and the figures, never the citations.
-- `answer_settled_at`: when it became ready or unavailable.
--
-- Query shapes: a thread's nodes in creation order (unchanged); the nodes whose answer is still being made, oldest
-- first (the sweep that ends a wait that took too long).
-- Locking: written under the starter's personal root by the worker (lock the node row FOR UPDATE), and by the
-- removal; the sweep locks one node row with SKIP LOCKED and nothing else.
-- Growth: three nullable columns on a row that exists per chosen branch; at most 5 branches per thread per UTC day.
-- Retention: kept with the node. Clear keeps nodes, so it keeps their answers; deleting an account clears only the
-- link to the person, and the answer carries none. A removed branch's answer is cleared in the removal.
-- Rollout: additive and nullable. An older writer that inserts a node without the columns leaves the branch with no
-- short answer, which the card draws as the branch card it always was.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table scenarios.nodes
  add column answer_state text,
  add column answer jsonb,
  add column answer_settled_at timestamptz;

alter table scenarios.nodes
  add constraint nodes_answer_state_check
    check (answer_state is null or answer_state in ('making', 'ready', 'unavailable')) not valid,
  add constraint nodes_answer_only_for_what_if check (answer_state is null or kind = 'what_if') not valid,
  add constraint nodes_answer_body_check
    check ((answer_state = 'ready') = (answer is not null)
      and (answer is null or (jsonb_typeof(answer) = 'object' and octet_length(answer::text) <= 8192))) not valid,
  add constraint nodes_answer_settled_check
    check ((answer_state in ('ready', 'unavailable')) = (answer_settled_at is not null)) not valid;
-- No row has an answer yet, so validating scans nothing that can fail; the table is one row per branch.
-- squawk-ignore constraint-missing-not-valid
alter table scenarios.nodes validate constraint nodes_answer_state_check;
-- squawk-ignore constraint-missing-not-valid
alter table scenarios.nodes validate constraint nodes_answer_only_for_what_if;
-- squawk-ignore constraint-missing-not-valid
alter table scenarios.nodes validate constraint nodes_answer_body_check;
-- squawk-ignore constraint-missing-not-valid
alter table scenarios.nodes validate constraint nodes_answer_settled_check;

-- squawk-ignore require-concurrent-index-creation
create index nodes_answer_making on scenarios.nodes (created_at, node_id) where answer_state = 'making';
