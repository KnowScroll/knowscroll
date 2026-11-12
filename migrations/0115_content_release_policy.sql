-- #674 (slice 3.3) The release policy of held library Scrolls (D-418): a person approves a topic once, and a worker may then release a later
-- Scroll of that topic by itself when the library support check passed, the topic is not sensitive and the day's cap allows. Built here and
-- OFF in every world until the owner sets KS_CONTENT_AUTO_RELEASE_ENABLED=1; the review gate (migration 0072) is unchanged and a policy release
-- goes through it, recorded in `content.revision_reviews.decided_by` as `policy:<name>`.
--
-- Owner: content. Authoritative for which topics a person approved for automatic release, the raises recorded against a revision, who withdrew a Scroll
-- the policy released, and what the release step last made of each held revision. Shared
-- content, not personal data: nothing here has a universe_id or an account column, and nothing is in the erasure registry. `approved_by`,
-- `revoked_by` and `proposed_by` name an operator's shell user (`cli:<name>`) or a model's role (`model:<role>`), never a person of the product.
-- Query shapes: the live approval of one topic (the partial unique index; the release step joins it for every held revision); the approvals of
-- one topic over time (the table is small: one row for each approval); the policy releases of the current UTC day (the partial index on
-- `content.revision_reviews` below, which the daily cap counts); the raises of one revision (the primary key's prefix); a revision's withdrawal and its
-- last look by the release step (their primary keys: the sweep left-joins the looks to the held revisions and orders them by the last look).
-- Locking: the release step takes the asset's content advisory lock, as every release does, then `content.release-policy` (an advisory lock that
-- orders the cap's count), inside the release transaction. An approval is one insert and a revocation one update, each its own short transaction.
-- Growth: `release_topic_approvals`, one row for each approval and each revocation of a topic (a handful a day at most). `release_risk_raises`,
-- at most one row for each revision, category and proposer. `release_withdrawals`, one row for each Scroll withdrawn after a policy release.
-- `release_policy_looks`, one row for each held revision the release step ever looked at (updated in place at each look). Retention: kept, except that a look is only
-- a hint (a missing one means "not looked at"); the others are the audit of why a Scroll was or was not released unread, and who took one down.
-- Rollout: additive. An older process never reads or writes these tables. With the switch off nothing releases whatever the rows say.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table content.release_topic_approvals (
  id uuid not null default gen_random_uuid(),
  -- A catalogue topic (a planet), not a system or a facet; code refuses anything else before it writes.
  topic_id text not null,
  approved_by text not null,
  approved_at timestamptz not null default now(),
  -- A revoked approval keeps its row, so who approved a topic and who took it back stay on record; a new approval is a new row.
  revoked_by text,
  revoked_at timestamptz,
  -- 'operator': `content policy revoke-topic`. 'withdrawal': revoked in the same transaction that withdrew a Scroll the policy released.
  revoked_for text,
  constraint release_topic_approvals_pkey primary key (id),
  constraint release_topic_approvals_topic_check check (topic_id ~ '^[a-z0-9][a-z0-9._-]{0,159}$'),
  constraint release_topic_approvals_approved_by_check check (approved_by like 'cli:%' and char_length(approved_by) <= 64),
  constraint release_topic_approvals_revoked_check check (
    (revoked_at is null) = (revoked_by is null) and (revoked_at is null) = (revoked_for is null)
  ),
  constraint release_topic_approvals_revoked_by_check check (revoked_by is null or (revoked_by like 'cli:%' and char_length(revoked_by) <= 64)),
  constraint release_topic_approvals_revoked_for_check check (revoked_for is null or revoked_for in ('operator', 'withdrawal'))
);

comment on table content.release_topic_approvals is 'Topics a person approved for automatic release of their later library Scrolls (D-418). One live (unrevoked) row for a topic at most. Approving changes nothing by itself: the release policy is off until the owner switches it on.';

create unique index release_topic_approvals_live on content.release_topic_approvals (topic_id) where revoked_at is null;
create index release_topic_approvals_topic on content.release_topic_approvals (topic_id, approved_at);

-- A raise of one revision's risk class: a model (or a person) says this Scroll touches a sensitive category, so it waits for a person. There is no
-- lowering: a row can neither be changed nor deleted, and the effective class of a revision is the highest of what code derives and every raise.
create table content.release_risk_raises (
  asset_id uuid not null,
  revision integer not null,
  category text not null,
  proposed_by text not null,
  proposed_at timestamptz not null default now(),
  constraint release_risk_raises_pkey primary key (asset_id, revision, category, proposed_by),
  -- Only a revision that went through the review gate can have a raise, as for the support check's results.
  constraint release_risk_raises_revision_fkey foreign key (asset_id, revision)
    references content.revision_reviews (asset_id, revision) on delete restrict,
  -- The owner's sensitive categories (`release-sensitive-data.ts`); a new one is a new migration and a new sensitivity version.
  constraint release_risk_raises_category_check check (
    category in ('medicine', 'health', 'law', 'finance', 'political_history', 'religious_history', 'current_events', 'safety')
  ),
  constraint release_risk_raises_proposed_by_check check (proposed_by ~ '^(model|cli):[a-z0-9][a-z0-9._-]{0,58}$')
);

comment on table content.release_risk_raises is 'Raises of a library Scroll revision''s risk class (D-418): append-only, so a proposal can only make a Scroll wait for a person, never let one through.';

create function content.release_risk_raise_immutable() returns trigger language plpgsql as $$
begin
  raise exception using message = 'CONTENT_RELEASE_RAISE_IMMUTABLE', errcode = '23514';
end;
$$;

create trigger release_risk_raise_immutable before update or delete on content.release_risk_raises
  for each row execute function content.release_risk_raise_immutable();

-- Who withdrew a Scroll the policy released, and when (`content policy withdraw`). The withdrawal itself is the asset's status, which has no author; this keeps
-- the first withdrawal of each revision (a repeat changes nothing), the topic it belonged to and what became of the topic's approval in the same transaction.
create table content.release_withdrawals (
  asset_id uuid not null,
  revision integer not null,
  withdrawn_by text not null,
  withdrawn_at timestamptz not null default now(),
  -- The revision's primary topic, or null when it had none.
  topic_id text,
  -- 'revoked': the topic's approval was live and is revoked now. 'already_revoked', 'never_approved': nothing to revoke. 'no_topic': the revision had no single topic.
  approval text not null,
  constraint release_withdrawals_pkey primary key (asset_id, revision),
  constraint release_withdrawals_revision_fkey foreign key (asset_id, revision)
    references content.revision_reviews (asset_id, revision) on delete restrict,
  constraint release_withdrawals_by_check check (withdrawn_by like 'cli:%' and char_length(withdrawn_by) <= 64),
  constraint release_withdrawals_topic_check check (topic_id is null or topic_id ~ '^[a-z0-9][a-z0-9._-]{0,159}$'),
  constraint release_withdrawals_approval_check check (approval in ('revoked', 'already_revoked', 'never_approved', 'no_topic'))
);

comment on table content.release_withdrawals is 'Scrolls withdrawn after the release policy released them (D-418): who, when, and what became of the topic''s approval. The first withdrawal of a revision is kept.';

-- What the release step last made of a held revision: the code it stayed held for and the rules it was judged under. The sweep reads held revisions least recently
-- looked at first (never looked at before any), so a crowd of revisions that stay held cannot stand in front of the next one, and it skips a revision whose hold is
-- permanent under the rules now in force (a sensitive Scroll, one whose document does not read or whose answer check did not pass cannot change). A look is a hint: deleting
-- one only makes the sweep look again.
create table content.release_policy_looks (
  asset_id uuid not null,
  revision integer not null,
  hold_code text not null,
  rules_version text not null,
  looked_at timestamptz not null default now(),
  constraint release_policy_looks_pkey primary key (asset_id, revision),
  constraint release_policy_looks_revision_fkey foreign key (asset_id, revision)
    references content.revision_reviews (asset_id, revision) on delete restrict,
  constraint release_policy_looks_check check (char_length(hold_code) between 1 and 64 and char_length(rules_version) between 1 and 160)
);

comment on table content.release_policy_looks is 'The last look of the release policy''s sweep at each held library revision (D-418): the hold code and the rules version, so the sweep pages past revisions that stay held.';

-- The daily cap counts the policy's releases of the UTC day. The table has one row for each held library revision, so the index is small.
-- squawk-ignore require-concurrent-index-creation
create index revision_reviews_policy_decided on content.revision_reviews (decided_at) where decided_by like 'policy:%';
