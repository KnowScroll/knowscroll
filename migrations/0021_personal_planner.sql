-- Owner: modules/planner. Derived plan proposals; never evidence or production admission.
-- Reads: exact caller/epoch state and run, last three accepted revisions by indexed revision.
-- Growth: one business run per coalesced revision batch, accepted revision audit retained until
-- personal erasure. Bounded frozen bundles <=512KiB; accepted outputs <=3/32KiB. No transcript.
-- Corrections invalidate by PC+desired revision; all epochs, job payloads and memory erased.
-- Additive rollout: old processes ignore these tables; execution defaults disabled in new workers.
-- Personal root precedes state/run rows. Claim fence bounds concurrent deliveries without locks
-- across provider I/O; the harness attempt ledger separately prevents an unknown resend.
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create schema planner;

create table planner.state (
  universe_id uuid not null references identity.universes(id) on delete restrict,
  privacy_epoch integer not null check (privacy_epoch > 0),
  desired_revision integer not null default 0 check (desired_revision >= 0),
  material_revision integer not null default 0 check (material_revision >= 0),
  accepted_revision integer not null default 0 check (accepted_revision >= 0 and accepted_revision <= desired_revision),
  active_run_id uuid,
  intent jsonb check (intent is null or (jsonb_typeof(intent) = 'object' and octet_length(intent::text) <= 4096)),
  primary key (universe_id, privacy_epoch)
);

create table planner.runs (
  universe_id uuid not null references identity.universes(id) on delete restrict,
  privacy_epoch integer not null check (privacy_epoch > 0),
  id uuid not null,
  revision integer not null check (revision > 0),
  status text not null check (status in ('queued','prepared','unknown','blocked','accepted','stale','rejected','insufficient')),
  claim_id uuid,
  claim_until timestamptz,
  context_version text,
  context jsonb check (context is null or (jsonb_typeof(context) = 'object' and octet_length(context::text) <= 524288)),
  outcome text check (outcome is null or length(outcome) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (universe_id, id),
  unique (universe_id, privacy_epoch, id),
  check ((context is null) = (context_version is null)),
  check ((claim_id is null) = (claim_until is null))
);
-- The personal-root protocol serialises state; this additionally refuses two active role runs.
create unique index planner_one_active_run on planner.runs(universe_id, privacy_epoch)
  where status in ('queued','prepared','unknown','blocked');
alter table planner.state add constraint planner_state_active_run_fk foreign key (universe_id,privacy_epoch,active_run_id)
  references planner.runs(universe_id,privacy_epoch,id) on delete restrict;

create table planner.revisions (
  universe_id uuid not null references identity.universes(id) on delete restrict,
  privacy_epoch integer not null check (privacy_epoch > 0),
  revision integer not null check (revision > 0),
  run_id uuid not null,
  context_revision integer not null check (context_revision >= 0),
  attempt_id uuid not null,
  policy_version text not null check (policy_version = 'personal-planner.v0'),
  opportunities jsonb not null check (jsonb_typeof(opportunities) = 'array' and jsonb_array_length(opportunities) <= 3 and octet_length(opportunities::text) <= 32768),
  created_at timestamptz not null default now(),
  primary key (universe_id,privacy_epoch,revision),
  foreign key (universe_id,privacy_epoch,run_id) references planner.runs(universe_id,privacy_epoch,id) on delete restrict
);
-- Accepted revisions are an audit; accepted memory reads only the latest three revisions.
create index planner_revision_recent on planner.revisions(universe_id,privacy_epoch,revision desc);
