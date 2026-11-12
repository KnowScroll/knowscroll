-- #674 (2.1 review) A request that waits to be matched keeps the catalogue release it was asked against (D-419): the shortlist a
-- model is shown is a function of the person's words and one release, so a redelivery after another release repeats the very
-- request it paid for, and a kept answer is checked against the shortlist it was given.
--
-- Owner: supply. Authoritative. One nullable integer on the person's own request row, beside `decision`.
-- `catalogue_release`: the number of the release (`content.concept_releases.release_id`) current when a free-text ask or a typed
-- question was recorded; set only on requests that wait to be matched (`state = 'matching'` at the time), null for every other
-- request, including every row that exists today (the matcher then reads the current release, as it did).
-- Query shapes: unchanged (the column rides on the row every read already takes). Locking: unchanged.
-- Access: the person reads their own request only. The value is a number any reader of the shared catalogue has; it names no
-- person, topic or word.
-- Growth: none (a column on a row that exists). Retention and erasure: the row's own; Clear and account deletion remove it with
-- the request. The export lists the request as before and does not include the column.
-- Rollout: additive and nullable. An older process neither reads nor writes the column and matches against the current release.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table supply.requests add column catalogue_release integer;
