-- #241 Social owns what a person lets friends see: who may visit their universe, the list of systems
-- and planets a visitor receives, and whether they show as available (D-047).
--
-- Owner: social. The settings and the audience are authoritative. The visit tables are a derived copy
-- of the owner's own Geography, drawn for visitors under public identities; the owner's Geography
-- stays the source and a refresh rebuilds the copy.
-- Query shapes: a visitor reads one owner's published systems and planets in order, after the
-- friendship and the owner's audience have been checked in the same transaction; a friends page reads
-- each listed friend's preference and last heartbeat by account; a heartbeat upserts one row.
-- Locking: settings and audience rows are written under the owner's personal root, as the friendship
-- rows are. A friendship that begins or ends deletes the audience rows between the two people under
-- the friendship's own lock, so an old choice never revives with a new friendship. A visitor's read
-- locks nobody else's root: it reads the published copy, never the owner's Geography.
-- Growth: one settings row and one presence row per person who ever changed a setting or showed
-- availability; one audience row per chosen friend; at most 100 systems and 100 planets per system
-- per universe (the contract limit).
-- Retention: settings, audience and presence are account-keyed and kept by Clear (they are choices
-- and a lapsing signal, not exploration history); account deletion removes them. The visit tables
-- are universe-keyed and are erased by Clear and by account deletion, so a friend who visits after a
-- Clear sees an empty universe until the owner shares systems of a new one. A presence row is only
-- written for a person who chose to show availability and is deleted when they choose to hide it.
-- Rollout: additive. No earlier writer exists for these tables.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- No row means the defaults: nobody may visit and availability is hidden (D-006 e). Reading never
-- writes, so a person who never opens the settings shares nothing. The two revisions are the
-- caller-visible counters of the two settings; neither leaves the owner.
create table social.visibility_settings (
  account_id uuid primary key references identity.accounts(id) on delete restrict,
  audience text not null default 'nobody' check (audience in ('nobody', 'chosen_friends', 'all_friends')),
  visibility_revision bigint not null default 1 check (visibility_revision between 1 and 9007199254740991),
  presence_preference text not null default 'hidden'
    check (presence_preference in ('online', 'recently_active', 'hidden')),
  presence_revision bigint not null default 1 check (presence_revision between 1 and 9007199254740991)
);

-- The friends an owner chose when the audience is `chosen_friends`. A row means something only while
-- the two are friends: the visit read checks the friendship too, and ending or beginning a
-- friendship deletes the rows between the two people.
create table social.visibility_audience (
  owner_account_id uuid not null references identity.accounts(id) on delete restrict,
  friend_account_id uuid not null references identity.accounts(id) on delete restrict,
  primary key (owner_account_id, friend_account_id),
  check (owner_account_id <> friend_account_id)
);
create index visibility_audience_friend on social.visibility_audience(friend_account_id);

-- When a person who shows availability last sent a heartbeat. Friends never read the time: they read
-- a word ("Online", "Recently active") derived from it. `window_number` counts the stretches of
-- activity separated by more than the recently-active horizon, and is the `expiryRevision` of the
-- availability answer. Not written for a person whose availability is hidden.
create table social.presence (
  account_id uuid primary key references identity.accounts(id) on delete restrict,
  last_seen_at timestamptz not null,
  window_number bigint not null default 1 check (window_number between 1 and 9007199254740991)
);

-- What visitors may be shown of one universe, as of the last refresh. `geography_revision` is the
-- Geography revision it was drawn from; `projection_revision` moves only when the list a visitor
-- would receive changes.
create table social.visit_publications (
  universe_id uuid primary key references identity.universes(id) on delete restrict,
  projection_revision bigint not null default 1 check (projection_revision between 1 and 9007199254740991),
  geography_revision bigint not null check (geography_revision between 0 and 9007199254740991),
  refreshed_at timestamptz not null
);

-- A system the owner chose to share. `system_id` is the owner's own Geography ID and is never sent to
-- a visitor; `public_system_id` is random, stable while the system stays shared, and the only
-- identity a visitor sees. Unsharing deletes the row, so sharing it again makes a new public identity.
-- There is no order column: a visitor's list is sorted by label, so the order says nothing about when
-- anything formed.
create table social.visit_systems (
  universe_id uuid not null references identity.universes(id) on delete restrict,
  system_id uuid not null,
  public_system_id uuid not null unique,
  label text not null check (char_length(label) between 1 and 160),
  primary key (universe_id, system_id)
);

-- A planet of a shared system, with the same public-identity rule. Regions are never published.
create table social.visit_planets (
  universe_id uuid not null references identity.universes(id) on delete restrict,
  planet_id uuid not null,
  system_id uuid not null,
  public_planet_id uuid not null unique,
  label text not null check (char_length(label) between 1 and 160),
  primary key (universe_id, planet_id),
  foreign key (universe_id, system_id) references social.visit_systems(universe_id, system_id) on delete cascade
);
create index visit_planets_system on social.visit_planets(universe_id, system_id);
