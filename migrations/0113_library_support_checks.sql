-- #674 (slice 3.2) The support check of library Scrolls (D-415): a model reads each sentence of a stored Scroll revision against the
-- passages that sentence's own part cites, and code records what became of every sentence and decides the revision's verdict. The check
-- informs the operator who reads a held revision; it releases, rejects and serves nothing. Its agreement with the operator's own release
-- and reject decisions is measured (`content support-check-replay`) before anything relies on it.
--
-- Owner: content. Authoritative for what a checker version said about a revision; the revision, its provenance and the operator's
-- decision stay where they are (`content.asset_revisions`, `content.asset_provenance`, `content.revision_reviews`). Shared content, not
-- personal data: nothing here has a universe_id or an account column, and nothing is in the erasure registry. The sentences are the
-- Scroll's own words (a stored revision is public once released) and the checker's short notes about the ones it flagged.
-- One row per revision and checker version, so a new checker version is a new measurement of the same revision and an old one is never
-- overwritten. `check_round` counts the tries: a check that ended on a provider failure (a conclusive failure ends the reasoning run for
-- good) is tried again in a new round, at most three and within eleven paid requests for the revision in all (`requests` is the total over every
-- round). `batch_failures` says how often each batch (by index) failed, so a later round asks only the batch that failed and those after it; the
-- batches answered before it are read back from the attempt ledger for nothing. Code `provider_failed` is a result still to be tried again,
-- `provider_failed_final` one that has used its rounds or its requests.
-- The key references the review gate's row, not just the revision: only a library or generated Scroll that went through the review gate can have
-- a check, so a made-to-order revision (a thread's branch, a person's question) can never be stored in this shared table.
-- Query shapes: one revision's result by its key (the primary key: the operator's review list and show read it, and the check job asks
-- whether it already ran); the held revisions that have no result yet (the held partial index of `content.revision_reviews`, then one
-- primary-key probe each); the results that ended on a provider failure and are due another round (the partial index below); and the results
-- of every revision the operator decided (the replay joins `content.revision_reviews` on the primary key).
-- Locking: the use case writes one row in one short transaction under the production root and closes the reasoning runs it used in the same
-- transaction; no model or network wait holds it. Two deliveries racing for one revision both read "no row", the first writes and the
-- second finds its runs closed or its insert a no-op.
-- Growth: one row per revision and checker version, about 20 KB of `sentences` for a checked revision (60 sentences with their quotes). Retention: kept; it is
-- the evidence of how the check agreed with the operator.
-- Rollout: additive. An older process never reads or writes the table, and the review list shows "not checked" for a revision with no row.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table content.library_support_checks (
  asset_id uuid not null,
  revision integer not null,
  checker_version text not null,
  -- 'checked': the checker gave a verdict for every sentence. 'unchecked': it gave nothing usable (`code` says why, never provider text).
  state text not null,
  code text,
  -- 'passed' or 'flagged' by the policy named in `policy_version`, decided by code from `sentences`; 'unchecked' with no verdict.
  verdict text not null,
  policy_version text not null,
  check_round integer not null default 1,
  -- How often each batch failed conclusively, by index: {"3": 1}. Empty when none did.
  batch_failures jsonb not null default '{}'::jsonb,
  sentence_count integer not null,
  batches integer not null,
  -- Paid requests the check sent, one for each batch and one more when the harness repaired an unusable reply.
  requests integer not null,
  -- [{n, part, field, text, label?, outcome, kind?, code?, problem?}], in reading order; empty when unchecked.
  sentences jsonb not null,
  checked_at timestamptz not null default now(),
  constraint library_support_checks_pkey primary key (asset_id, revision, checker_version),
  constraint library_support_checks_revision_fkey foreign key (asset_id, revision)
    references content.revision_reviews (asset_id, revision) on delete restrict,
  constraint library_support_checks_state_check check (state in ('checked', 'unchecked')),
  constraint library_support_checks_verdict_check check (verdict in ('passed', 'flagged', 'unchecked')),
  -- A checked result has a verdict and no code; an unchecked one has a code and no verdict.
  constraint library_support_checks_outcome_check
    check ((state = 'checked') = (verdict <> 'unchecked') and (state = 'checked') = (code is null)),
  constraint library_support_checks_code_check check (code is null or char_length(code) between 1 and 64),
  constraint library_support_checks_version_check
    check (char_length(checker_version) between 1 and 64 and char_length(policy_version) between 1 and 64),
  constraint library_support_checks_round_check check (check_round between 1 and 3),
  constraint library_support_checks_failures_check check (jsonb_typeof(batch_failures) = 'object'),
  constraint library_support_checks_counts_check check (sentence_count >= 0 and batches >= 0 and requests >= 0),
  constraint library_support_checks_sentences_check check (
    jsonb_typeof(sentences) = 'array'
    and jsonb_array_length(sentences) = case when state = 'checked' then sentence_count else 0 end
  )
);

comment on table content.library_support_checks is 'What a version of the library support check said about one Scroll revision: a verdict for every sentence and the revision verdict code decided from them. Informs the operator at the review gate; releases and rejects nothing.';

create index library_support_checks_retry on content.library_support_checks (checked_at)
  where state = 'unchecked' and code = 'provider_failed';
