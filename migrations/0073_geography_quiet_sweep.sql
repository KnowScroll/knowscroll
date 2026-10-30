-- #467 (v3 U-3) Places go quiet without new reading: the quiet sweep (D-104). Owner: modules/geography.
--
-- geography.state gains `next_quiet_at`, the earliest time the sweep needs to look at this universe: when the
-- newest support under an active place turns 30 days old, or now when a change is already due. Derived
-- scheduling state, never evidence: every Cartographer apply and every sweep pass rewrites it, and a pass that
-- finds nothing due stores the corrected value. Null means no place can go quiet.
-- geography.deltas.run_id becomes nullable: a delta that only changes activity because time passed has no
-- Cartographer run. Nothing reads run_id back; the foreign key does not apply to a null.
--
-- Query shapes: the scheduled sweep takes the due states in order (partial index below), at most 100 a pass,
-- skipping rows another transaction holds; the state row is otherwise read and written by its primary key.
-- Growth: one timestamp on a row that exists once per universe and epoch; one small index entry per universe
-- that has an active place. Retention and erasure: the state row's, unchanged (Clear and account deletion
-- delete it). The sweep's job payloads are erased with the other geography queues.
-- Lock order: unchanged. The sweep reads state rows without the personal root; the settle it enqueues takes the
-- root first, like a Cartographer run.
-- Rollout: additive. An older writer never touches the column and an older reader ignores it. A state row that an
-- older writer creates has no value until the next apply or the next settle writes one.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table geography.state add column next_quiet_at timestamptz;

-- Existing state inventory is a handful of rows per universe; the transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create index geography_state_quiet_due on geography.state(next_quiet_at) where next_quiet_at is not null;

-- Nothing reads the run of a delta; rows written before this keep theirs.
-- squawk-ignore ban-drop-not-null
alter table geography.deltas alter column run_id drop not null;

-- Every world that has places is due once: the first sweep reads its support and stores the true time.
update geography.state state set next_quiet_at = now()
where exists (
  select 1 from geography.objects object
  where object.universe_id = state.universe_id and object.privacy_epoch = state.privacy_epoch
);
