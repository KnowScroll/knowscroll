-- ADR-0029 amendment (#113): composer-signals-v1's only tie-break, once every unread candidate
-- scores identically, was a hash of `assetId` -- deterministic, but with no connection to whether
-- a source had ever been offered. In a shared library with more unread assets than slate slots, an
-- abundant source with many low-hashing assets could keep winning every tie forever while a
-- smaller, unlucky-hashing source was never offered at all: #113 observed twelve consecutive
-- decisions offering no candidate from one specific source.
--
-- `packages/core/AGENTS.md`: "Changing ranking requires a new policy version ... never a
-- code-constant edit to the scoring function." So this migration does not touch migration 0019's
-- 'composer-signals-v1' row at all -- it stays exactly as seeded, immutable, and simply stops being
-- loaded by any code path. Instead this registers a new, separately versioned policy,
-- 'composer-signals-v2', with the identical published weights/slate_size/max_per_source (the score
-- formula does not change) but paired with a ranking implementation
-- (`packages/core/src/composer.ts`) that adds one coverage tie-break: among candidates the score
-- cannot separate, prefer the source with fewer recorded exposures in this universe. That is the
-- property this migration exists to let a decision honestly record.

INSERT INTO composer_policy(version, weights, slate_size, max_per_source) VALUES (
  'composer-signals-v2',
  '{"unreadBonus": 100, "exposurePenalty": 10, "recencyBonus": 1}'::jsonb,
  3,
  2
);

-- The coverage tie-break's own signal, additive to migration 0018's `decision_signal.inputs`
-- contract: `?&` only requires its listed keys to be present, so a superset was always legal --
-- this migration makes the new key structurally required rather than merely promised by a caller,
-- for every decision_signal row recorded from here on (not scoped to one ranking_version, matching
-- how the original required-keys check is not scoped to one version either). Never rewrites or
-- relaxes migration 0018's own CHECK; only adds to what an honest row must carry.
ALTER TABLE decision_signal ADD CONSTRAINT decision_signal_source_exposure_count_valid CHECK (
  inputs ? 'sourceExposureCount'
  AND jsonb_typeof(inputs->'sourceExposureCount') = 'number'
  AND (inputs->>'sourceExposureCount')::numeric >= 0
);
