-- #609 (v3) A person's History and export leave out what was opened while recording was paused (D-284).
--
-- Owner: experience (`experience.exposures`).
-- Before: opening an item while recording was paused still wrote an exposure, and the export's encounter list, the
-- "continue" prompt and the thread and branch "opened" marks read every exposure, so a paused person's History grew.
-- After: an exposure carries `made_while_paused`. It is true when recording was paused at the moment the exposure was
-- opened or activated. The exposure stays, because it serves the item (media grants, calls, Ask from here, Back); the
-- personal reads that tell a person what they opened skip it.
--
-- Query shapes: the reads add `not made_while_paused` to predicates that are already bounded by universe, epoch and
-- asset or recency, so no new index is needed. The flag is never read on its own.
-- Backfill: an exposure made by an offer's activation whose command remembered no recording generation was made while
-- recording was not collecting (paused, or at a stale generation), and is marked. A direct open made before this migration left no such memory and stays
-- unmarked.
-- Growth, retention, erasure: one boolean on a row that already exists; erased with the exposure.
-- Rollout: additive. An older process never sets the flag, so its exposures read as recorded, as they did before.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table experience.exposures add column made_while_paused boolean not null default false;

update experience.exposures as exposure
set made_while_paused = true
from experience.recording_command_origins as origin
where origin.universe_id = exposure.universe_id
  and origin.privacy_epoch = exposure.privacy_epoch
  and origin.command_id = exposure.command_id
  and origin.operation = 'experience.activate-offer-v0'
  and origin.eligible_generation is null;
