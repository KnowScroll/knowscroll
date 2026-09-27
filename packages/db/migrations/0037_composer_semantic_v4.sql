-- ADR-0043 §7 (#167): the Composer comparison with Reels in the library found one defect in
-- composer-semantic-v3, in its tie-break. v3 breaks score ties with FNV-1a over `seed:assetId`; the
-- editorial Scrolls' ids are sequential and FNV-1a barely mixes the last characters, so the whole
-- library's keys cluster and fall, per universe, before or after the Reels' random ids together. A new
-- reader's first slate was all Reels in 42% of simulated cold starts (3% if ties were fair).
--
-- `packages/core/AGENTS.md`: changing ranking requires a new policy version, never an edit. So v3's
-- row (migration 0027) is untouched and keeps breaking ties with plain FNV-1a; a row without
-- `tieBreak` predates the field. 'composer-semantic-v4' is v3's row with exactly one added field:
-- `tieBreak: "fnv1a-fmix32"`, the same key through murmur3's 32-bit finalizer. It records the same
-- decision_candidate rows under the same reason templates and commit-time invariants.
INSERT INTO composer_policy(version, weights, slate_size, max_per_source, record_kind)
SELECT 'composer-semantic-v4', weights || '{"tieBreak":"fnv1a-fmix32"}'::jsonb, slate_size, max_per_source, record_kind
FROM composer_policy WHERE version = 'composer-semantic-v3';
