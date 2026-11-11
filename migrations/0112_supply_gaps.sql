-- #674 (3.1) The gap loop (D-414): content that is running out is noticed by code, and new recipes are proposed for it
-- within budget, still held for an operator's read.
--
-- Owner: supply. Three new tables and one view, and one value added to a check.
-- 1. `supply.gaps`: one row per open hole in the library: a planet below its released-unit or facet floor, a facet with no
--    released Scroll, a planet below the depth target, or demand readers' own reading left unmet (`demand`). Authoritative,
--    shared, nonpersonal: a planet and a facet are catalogue ids, and no person, no words and no private id is in it. The key
--    is the SHA-256 of kind, planet and facet (derived by code), and at most one row may be open for a key: the partial unique
--    index below holds while the status is not `closed` or `rejected`, so a scan that runs twice, or two scans at once, make one
--    gap. Status: `open` (known, nothing done), `briefed` (recipes were proposed and stored, none commissioned yet),
--    `commissioned` (production was sent for at least one and the Scroll waits for a release), `closed` (the hole is filled or
--    gone), `rejected` (two failed attempts, or a refusal that no retry can change; `reason` says which), `blocked_unknown` (a
--    proposing attempt whose outcome is unknown: it is never resent, an operator settles it). `priority` is structural severity
--    times 100 plus a bounded log of the readers, so severity always comes first and age (`first_seen_at`) breaks ties.
--    `attempts` counts failed proposing attempts (at most two); `attempt_day` pins the UTC day of the attempt in flight so a
--    redelivery after midnight is the same request, and is cleared when the attempt ends; `proposal_run_id` and `recipes`
--    (at most three keys) say what the last proposal stored.
--    Query shapes: the actionable gaps in priority order (partial index), the open row of a key (the unique index), the latest
--    rejected row of a key (the reopen check), proposing attempts since the start of a UTC day, and the operator's list.
--    Locking: a row is written by the scan (inside one advisory lock, so one scan runs at a time) and by the brief job one gap
--    at a time under that row's own lock. Growth: at most one open row per planet and facet of the catalogue, and a few
--    closed ones; closed and rejected rows are deleted after 90 days by the scan, in bounded batches. Erasure: shared, nothing
--    personal; survives Clear and account deletion.
-- 2. `supply.gap_signals`: a daily counter of the distinct readers who were near the end of a planet or facet, who found no
--    recipe left for a planned demand or an ask, or who were given a repeat as a last resort. One row per gap key and UTC day:
--    the number of readers only. It holds no person (the planet and facet are catalogue ids), so it survives erasure like the
--    other ledgers (`supply.ask_orders`, `supply.planned_demand_outcomes`). Demand is never evidence: no ranking, plan,
--    evidence or place reads this table or the gaps. Written only by the scan's roll-up (below); deleted after 30 days.
-- 3. `supply.gap_signal_marks`: the one private row that makes "one count per person per gap per day" true without keeping a
--    person in the counter. The personal transaction that knows the signal writes its mark (its own row, no shared row is
--    locked, so no reader waits on another) and `on conflict do nothing`: the second signal of the day for the same gap is no
--    row. The scan then counts the new marks into `supply.gap_signals` and marks them `counted`; a mark older than three days
--    is deleted by the scan. Personal: erased with the person (full erasure and Clear), not exported (derived bookkeeping of at
--    most three days, no words). Growth: at most one row per person, gap and day, three days kept.
-- 4. `ops.supply_gaps`: the operator's reviewed view of the gaps: codes, counts and catalogue ids, no recipe text.
-- 5. `supply.work.commissioned_by` gains `growth`: the loop commissions production through the same group row, so the growth cap
--    (counted from the groups of stored recipes started that UTC day) counts it. A `growth` group holds a catalogue brief and
--    a recipe key, like every group.
-- Lock order: unchanged. The scan takes its own advisory lock first (try-lock: a second scan simply does not run), then rows of
-- its own tables. The brief job takes the commissioning advisory lock (as Create does) and then the group row.
-- Rollout: additive. An older process never reads or writes any of this and never writes `growth`. The loop is off in every
-- world until `KS_SUPPLY_GROWTH_ENABLED=1`, so nothing here moves until an operator turns it on.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table supply.gaps (
  id uuid not null,
  key text not null,
  kind text not null,
  planet text not null,
  facet text,
  priority integer not null,
  readers integer not null default 0,
  status text not null default 'open',
  attempts integer not null default 0,
  reason text,
  attempt_day date,
  last_attempt_at timestamptz,
  proposal_run_id uuid,
  recipes text[] not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  commissioned_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint gaps_pkey primary key (id),
  constraint gaps_key_check check (key ~ '^[0-9a-f]{64}$'),
  constraint gaps_kind_check check (kind in ('thin_planet', 'empty_facet', 'shallow_planet', 'demand')),
  constraint gaps_planet_check check (char_length(planet) between 1 and 160),
  constraint gaps_facet_check check (facet is null or char_length(facet) between 1 and 160),
  -- A facet gap names its facet, a planet gap does not; demand may name either.
  constraint gaps_shape_check check (
    (kind = 'empty_facet' and facet is not null)
    or (kind in ('thin_planet', 'shallow_planet') and facet is null)
    or kind = 'demand'
  ),
  constraint gaps_priority_check check (priority between 0 and 1000),
  constraint gaps_readers_check check (readers >= 0),
  constraint gaps_status_check
    check (status in ('open', 'briefed', 'commissioned', 'closed', 'rejected', 'blocked_unknown')),
  constraint gaps_attempts_check check (attempts between 0 and 2),
  constraint gaps_reason_check check (reason is null or reason ~ '^[a-z][a-z0-9_]{0,47}$'),
  constraint gaps_recipes_check check (cardinality(recipes) <= 3),
  -- A rejected gap says why, and only an ended gap has an end.
  constraint gaps_rejected_reason_check check (status <> 'rejected' or reason is not null),
  constraint gaps_closed_check check ((status in ('closed', 'rejected')) = (closed_at is not null))
);

comment on table supply.gaps is
  'One open hole in the library, found by a scheduled SQL scan or a counted signal. Shared, nonpersonal: catalogue ids and counts only. Demand is never evidence.';

create unique index supply_gaps_open_key on supply.gaps (key) where status not in ('closed', 'rejected');
create index supply_gaps_actionable on supply.gaps (priority desc, first_seen_at, id) where status in ('open', 'briefed');
create index supply_gaps_rejected_key on supply.gaps (key, closed_at desc) where status = 'rejected';
create index supply_gaps_attempted on supply.gaps (last_attempt_at) where last_attempt_at is not null;
create index supply_gaps_ended on supply.gaps (closed_at) where closed_at is not null;

create table supply.gap_signals (
  key text not null,
  day date not null,
  planet text not null,
  facet text,
  readers integer not null,
  constraint gap_signals_pkey primary key (key, day),
  constraint gap_signals_key_check check (key ~ '^[0-9a-f]{64}$'),
  constraint gap_signals_planet_check check (char_length(planet) between 1 and 160),
  constraint gap_signals_facet_check check (facet is null or char_length(facet) between 1 and 160),
  constraint gap_signals_readers_check check (readers between 1 and 1000000000)
);

comment on table supply.gap_signals is
  'The distinct readers a UTC day counted for a gap key, from the scan''s roll-up of the private marks. A count only: no person.';

create index gap_signals_day on supply.gap_signals (day);

create table supply.gap_signal_marks (
  universe_id uuid not null references identity.universes (id) on delete restrict,
  privacy_epoch integer not null,
  day date not null,
  key text not null,
  source text not null,
  planet text not null,
  facet text,
  counted boolean not null default false,
  constraint gap_signal_marks_pkey primary key (universe_id, privacy_epoch, day, key),
  constraint gap_signal_marks_epoch_check check (privacy_epoch > 0),
  constraint gap_signal_marks_key_check check (key ~ '^[0-9a-f]{64}$'),
  constraint gap_signal_marks_source_check
    check (source in ('last_resort', 'low_headroom', 'planned_demand', 'ask')),
  constraint gap_signal_marks_planet_check check (char_length(planet) between 1 and 160),
  constraint gap_signal_marks_facet_check check (facet is null or char_length(facet) between 1 and 160)
);

comment on table supply.gap_signal_marks is
  'A person''s own one-per-day mark for a gap signal, so the shared counter counts each reader once. Personal: erased with the person, never exported, deleted after three days.';

create index gap_signal_marks_uncounted on supply.gap_signal_marks (day) where not counted;
create index gap_signal_marks_day on supply.gap_signal_marks (day);

-- The loop's groups are growth: counted by the growth cap like every group of a stored recipe, and named so an operator can tell them.
-- squawk-ignore ban-drop-constraint
alter table supply.work drop constraint supply_work_commissioned_by;
alter table supply.work add constraint supply_work_commissioned_by
  check (commissioned_by is null or commissioned_by in ('person', 'planner', 'growth')) not valid;
-- Every existing row holds one of the earlier values, so the wider check holds.
-- squawk-ignore constraint-missing-not-valid
alter table supply.work validate constraint supply_work_commissioned_by;

create view ops.supply_gaps as
select
  id as gap_id,
  ops.safe_code(kind) as kind,
  ops.safe_code(planet) as planet,
  ops.safe_code(facet) as facet,
  ops.safe_code(status) as status,
  priority,
  readers,
  attempts,
  ops.safe_code(reason) as reason,
  cardinality(recipes) as recipes,
  first_seen_at,
  last_seen_at,
  last_attempt_at,
  commissioned_at,
  closed_at
from supply.gaps;

comment on view ops.supply_gaps is
  'The library''s open and ended holes: kind, catalogue planet and facet, status, priority, readers, attempts and reason codes. No recipe text, no person.';
