-- ADR-0028 implementation slice (#114/#5): registers the first real ranking policy and its
-- explanation vocabulary. Migration 0017 built the contract but seeded nothing; this migration
-- seeds exactly the two immutable rows a real Composer implementation needs to start setting
-- `decision.ranking_version` — nothing here changes retrieval, and no existing decision is
-- touched (ranking_version stays NULL for every row already written).

-- `composer-signals-v1`: bounded 3-item slate (same bound `editorial-unkept-v1` already used),
-- at most 2 of those 3 from any one source (ADR-0028 section 3 — a single source cannot occupy
-- an entire slate whenever a second source has any eligible candidate). Weights are data: an
-- unread candidate outranks any already-exposed one by a wide, deliberate margin; among exposed
-- candidates, fewer prior exposures and a longer gap since the last one rank higher. This is the
-- entire scoring function — see `packages/core/src/composer.ts` `scoreSignal`.
INSERT INTO composer_policy(version, weights, slate_size, max_per_source) VALUES (
  'composer-signals-v1',
  '{"unreadBonus": 100, "exposurePenalty": 10, "recencyBonus": 1}'::jsonb,
  3,
  2
);

-- Two registered explanations, chosen only by the recorded `unread` fact, citing only recorded
-- signals (never a belief about the reader). `sourceTitle` is the one documented passthrough
-- (ADR-0028 section 5), copied verbatim from `asset.source_title` into `decision_signal.inputs`.
INSERT INTO composer_explanation_template(explanation_key, template) VALUES
  ('composer_unread', 'A new sourced encounter from {{sourceTitle}}. No prior exposure is recorded.'),
  ('composer_resurfaced', 'From {{sourceTitle}}: shown {{exposureCount}} time(s) before, last shown {{recencyDays}} day(s) ago.');
