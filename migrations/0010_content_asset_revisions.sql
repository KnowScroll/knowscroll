-- 0010_content_asset_revisions: immutable admitted revisions of an asset, and the internal
-- provenance each revision rests on (S1.6, #229).
--
-- Owner: content module. Authoritative. Shared content, not personal data: neither table has a
--   universe_id or an account column, and neither is in the erasure registry. A revision is never
--   updated; a change is a new revision.
-- Reads: one revision by (asset_id, revision) (opening a Scroll, rendering it for a client,
--   reading its block weights for evidence); the current revision through content.assets.
-- Writes: admission only (the operator import command today, generation and Cutroom import in
--   later phases), one transaction per revision: the revision, its provenance and the asset's
--   current revision together.
-- Growth: one row per admitted revision; documents are bounded to 256 KiB of JSON text.
-- Retention: kept. The consumer document and the internal provenance are separate tables so no
--   read of the document can return claims, sources or production records; nothing in the API
--   reads asset_provenance.
-- Rollout: new tables. Older processes never read them (they only know content.assets).

-- Bounded waits: a migration fails fast instead of queueing behind live traffic (CF-27 backup first).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table content.asset_revisions (
  asset_id uuid not null,
  revision integer not null,
  -- How the revision came to be. The labels are product facts (D-005): an authored starter is
  -- never presented as generated.
  provenance_kind text not null,
  -- The consumer document (for a Scroll: scroll-document.v1), exactly what admission accepted.
  document_version text not null,
  document jsonb not null,
  -- integrity.sha256 of the document (canonical JSON without integrity and rendition).
  document_sha256 text not null,
  explanation_unit_id text not null,
  language text not null,
  title text not null,
  -- Derived by content from the document at admission: block weights and the reading estimate
  -- the evidence module qualifies a reading with. Versioned; never an independent copy of truth.
  reading_facts jsonb not null,
  admitted_at timestamptz not null default now(),
  constraint asset_revisions_pkey primary key (asset_id, revision),
  constraint asset_revisions_asset_fkey foreign key (asset_id) references content.assets (id) on delete restrict,
  constraint asset_revisions_revision_check check (revision >= 1),
  constraint asset_revisions_provenance_kind_check check (provenance_kind in ('authored_editorial', 'generated', 'cutroom_import')),
  constraint asset_revisions_document_version_check check (document_version ~ '^[a-z][a-z0-9.-]{1,39}$'),
  constraint asset_revisions_document_check check (jsonb_typeof(document) = 'object' and octet_length(document::text) <= 262144),
  constraint asset_revisions_sha256_check check (document_sha256 ~ '^[0-9a-f]{64}$'),
  constraint asset_revisions_facts_check check (jsonb_typeof(reading_facts) = 'object' and octet_length(reading_facts::text) <= 65536)
);

create table content.asset_provenance (
  asset_id uuid not null,
  revision integer not null,
  provenance_version text not null,
  -- Internal only: claims, sources, bindings, checks and the production record. Never served.
  provenance jsonb not null,
  recorded_at timestamptz not null default now(),
  constraint asset_provenance_pkey primary key (asset_id, revision),
  constraint asset_provenance_revision_fkey foreign key (asset_id, revision) references content.asset_revisions (asset_id, revision) on delete restrict,
  constraint asset_provenance_version_check check (provenance_version ~ '^[a-z][a-z0-9.-]{1,39}$'),
  constraint asset_provenance_check check (jsonb_typeof(provenance) = 'object' and octet_length(provenance::text) <= 262144)
);
