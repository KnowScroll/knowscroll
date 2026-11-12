-- #674 (2.1) The topic catalogue as data (D-419): systems, topics and facets live in Postgres, so adding a topic is a release, not a deploy.
--
-- Owner: content. Authoritative. Shared content, not personal data: nothing here has a universe_id or an account column, and
-- nothing is in the erasure registry. A node is a catalogue id, a label and a meaning; no person, no words of a person, no
-- count of readers.
-- 1. `content.concept_releases`: one row per release, numbered 1, 2, 3 ... with the SHA-256 digest of the catalogue it made
--    (`content-concepts.v1`, the digest every earlier coverage mapping recorded). A release is append-only: the catalogue of release
--    N is every node and revision introduced up to N, so what a Geography run pinned reads the same for ever. `source`: `seed`
--    (the first release, the library plan as it was when the catalogue was code), `plan` (an import of the TypeScript plan),
--    `visibility` (topics that gained released supply), `operator` (any other step). `summary` is counts only.
-- 2. `content.concept_nodes`: one row per system, topic and facet. The id is the stable id and is never reused: the existing slugs are
--    the first ids, and the id of a node that retired stays taken. `seq` is creation order over the whole catalogue: the catalogue's order and
--    a facet's site on its planet, so adding a facet never moves one. `introduced_in`, `visible_in` and `retired_in` are
--    release numbers: a topic is servable (offered, matched, listed, made a room) from `visible_in`, which a new topic gets only
--    when the library has released supply for it (three explanations over two facets by default), and a seeded topic has at
--    once. `status` and `merged_into` say where a retired node's readers go. Only `visible_in` and `retired_in`, `status` and `merged_into` may ever
--    change, once, from empty (a trigger), and a row is never deleted.
-- 3. `content.concept_node_revisions`: immutable revisions of a node: label, meaning and `meaning_sha256` (the identity of that
--    wording), `compatible_with` (the identities of earlier wordings this one only rephrases, so a wording-only edit keeps the
--    certificates decided against them valid; a semantic change lists none), the formation thresholds a node carries (defaults 2
--    for a system, 3 units over 2 facets for a topic, the numbers `geography-passive.v1` used), and the scene family and haze a
--    system or topic is drawn with. Scenes gives each once and never changes it (D-102), so a node's look is fixed by its first revision.
-- 4. `content.concept_current`: the one row that points at the current release. It only moves forward.
-- Query shapes: the current release (the one row, joined to its release); every node and revision up to a release (the catalogue as
-- of N: sequential reads of tables that hold one row per node and a few more per reworded one); the newest revision of one node.
-- Locking: a release is made in one transaction under the advisory lock `content.concept-releases`, which reads the current
-- release, checks every change by code, inserts the new rows and moves the pointer; readers take no lock and read releases that
-- are already committed. Growth: one row per node, ten thousand topics and their facets are tens of thousands of rows, one
-- release row per step. Retention: none; every release is kept so a pinned run can always read its catalogue.
-- Rollout: additive. An older process never reads these tables and keeps its code plan, which this migration seeds unchanged: release 1
-- is exactly the six systems, seventeen topics and fifty-three facets of the plan, every topic servable, so nothing a reader sees changes.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table content.concept_releases (
  release_id integer not null,
  digest text not null,
  source text not null,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint concept_releases_pkey primary key (release_id),
  constraint concept_releases_id_check check (release_id >= 1),
  constraint concept_releases_digest_check check (digest ~ '^[0-9a-f]{64}$'),
  constraint concept_releases_source_check check (source in ('seed', 'plan', 'visibility', 'operator')),
  constraint concept_releases_summary_check
    check (jsonb_typeof(summary) = 'object' and octet_length(summary::text) <= 2048)
);

comment on table content.concept_releases is
  'One release of the topic catalogue: a number and the digest of the catalogue it made. Append-only. Shared, nonpersonal.';

create table content.concept_nodes (
  node_id text not null,
  kind text not null,
  parent_id text,
  seq integer not null,
  status text not null default 'active',
  merged_into text,
  introduced_in integer not null,
  visible_in integer,
  retired_in integer,
  created_at timestamptz not null default now(),
  constraint concept_nodes_pkey primary key (node_id),
  constraint concept_nodes_seq_key unique (seq),
  constraint concept_nodes_id_check check (
    char_length(node_id) between 1 and 160
    and node_id ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)*$'
  ),
  constraint concept_nodes_kind_check check (kind in ('system', 'topic', 'facet')),
  -- A system has no parent; a topic and a facet each have one.
  constraint concept_nodes_parent_check check ((kind = 'system') = (parent_id is null)),
  constraint concept_nodes_status_check check (status in ('active', 'retired')),
  constraint concept_nodes_retired_check check ((status = 'retired') = (retired_in is not null)),
  constraint concept_nodes_merged_check check (merged_into is null or status = 'retired'),
  -- Only a topic has a servable date: a system is servable when one of its topics is, a facet with its topic.
  constraint concept_nodes_visible_check check (kind = 'topic' or visible_in is null),
  constraint concept_nodes_seq_check check (seq >= 1),
  constraint concept_nodes_parent_fkey foreign key (parent_id) references content.concept_nodes (node_id),
  constraint concept_nodes_merged_fkey foreign key (merged_into) references content.concept_nodes (node_id),
  constraint concept_nodes_introduced_fkey foreign key (introduced_in) references content.concept_releases (release_id),
  constraint concept_nodes_visible_fkey foreign key (visible_in) references content.concept_releases (release_id),
  constraint concept_nodes_retired_fkey foreign key (retired_in) references content.concept_releases (release_id)
);

comment on table content.concept_nodes is
  'The systems, topics and facets of the catalogue, by stable id (never reused). Shared, nonpersonal. Only visible_in, retired_in, status and merged_into ever change, once.';

create index concept_nodes_parent on content.concept_nodes (parent_id, seq) where parent_id is not null;
create index concept_nodes_introduced on content.concept_nodes (introduced_in);

create table content.concept_node_revisions (
  node_id text not null,
  revision integer not null,
  introduced_in integer not null,
  label text not null,
  meaning text not null,
  meaning_sha256 text not null,
  compatible_with text[] not null default '{}',
  system_units smallint,
  planet_units smallint,
  planet_facets smallint,
  scene_family text,
  haze text,
  created_at timestamptz not null default now(),
  constraint concept_node_revisions_pkey primary key (node_id, revision),
  constraint concept_node_revisions_revision_check check (revision >= 1),
  constraint concept_node_revisions_label_check check (char_length(label) between 2 and 80),
  constraint concept_node_revisions_meaning_check check (char_length(meaning) between 16 and 300),
  constraint concept_node_revisions_sha_check check (meaning_sha256 ~ '^[0-9a-f]{64}$'),
  constraint concept_node_revisions_compatible_check check (cardinality(compatible_with) <= 16),
  constraint concept_node_revisions_system_units_check check (system_units is null or system_units between 1 and 100),
  constraint concept_node_revisions_planet_units_check check (planet_units is null or planet_units between 1 and 100),
  constraint concept_node_revisions_planet_facets_check check (planet_facets is null or planet_facets between 1 and 16),
  constraint concept_node_revisions_scene_check
    check (scene_family is null or scene_family in ('terraced.v1', 'ridged.v1', 'archipelago.v1')),
  constraint concept_node_revisions_haze_check
    check (haze is null or haze in ('teal', 'cobalt', 'coral', 'amber', 'pink', 'violet')),
  constraint concept_node_revisions_node_fkey foreign key (node_id) references content.concept_nodes (node_id),
  constraint concept_node_revisions_introduced_fkey foreign key (introduced_in) references content.concept_releases (release_id)
);

comment on table content.concept_node_revisions is
  'Immutable revisions of a catalogue node: label, meaning, the identities of earlier wordings it only rephrases, formation thresholds, look. Shared, nonpersonal.';

create index concept_node_revisions_introduced on content.concept_node_revisions (introduced_in);

create table content.concept_current (
  singleton boolean not null default true,
  release_id integer not null,
  constraint concept_current_pkey primary key (singleton),
  constraint concept_current_singleton_check check (singleton),
  constraint concept_current_release_fkey foreign key (release_id) references content.concept_releases (release_id)
);

comment on table content.concept_current is
  'The one row that names the current catalogue release. It only moves forward.';


-- Release 1: the library plan as it was when the catalogue was code (6 systems, 17 topics, 53 facets). Every topic is servable at
-- once. Labels are made from ids and each digest is the canonical SHA-256 the code computes; `catalogue-equivalence`
-- (integration) reads these rows back and compares them with the plan, so a drift between this file and the plan fails CI.
insert into content.concept_releases (release_id, digest, source, summary) values (1, 'b2c474bed5f2f0d6dafcc9c8663ff1b0a9279b143312a970f2f591882941e6cd', 'seed', '{"addedSystems":6,"addedTopics":17,"addedFacets":53,"revised":0,"rewordedOnly":0,"shown":0,"retired":0}'::jsonb);
insert into content.concept_nodes (node_id, kind, parent_id, seq, status, introduced_in, visible_in) values
  ('earth', 'system', null, 1, 'active', 1, null),
  ('earth.seasons', 'topic', 'earth', 2, 'active', 1, 1),
  ('earth.seasons.axial-tilt', 'facet', 'earth.seasons', 3, 'active', 1, null),
  ('earth.seasons.hemispheres', 'facet', 'earth.seasons', 4, 'active', 1, null),
  ('earth.seasons.limits', 'facet', 'earth.seasons', 5, 'active', 1, null),
  ('earth.seasons.elsewhere', 'facet', 'earth.seasons', 6, 'active', 1, null),
  ('earth.tides', 'topic', 'earth', 7, 'active', 1, 1),
  ('earth.tides.forcing', 'facet', 'earth.tides', 8, 'active', 1, null),
  ('earth.tides.alignment', 'facet', 'earth.tides', 9, 'active', 1, null),
  ('earth.tides.coasts', 'facet', 'earth.tides', 10, 'active', 1, null),
  ('earth.greenhouse-effect', 'topic', 'earth', 11, 'active', 1, 1),
  ('earth.greenhouse-effect.radiation', 'facet', 'earth.greenhouse-effect', 12, 'active', 1, null),
  ('earth.greenhouse-effect.balance', 'facet', 'earth.greenhouse-effect', 13, 'active', 1, null),
  ('earth.greenhouse-effect.limits', 'facet', 'earth.greenhouse-effect', 14, 'active', 1, null),
  ('space', 'system', null, 15, 'active', 1, null),
  ('space.stars', 'topic', 'space', 16, 'active', 1, 1),
  ('space.stars.fusion', 'facet', 'space.stars', 17, 'active', 1, null),
  ('space.stars.lifecycle', 'facet', 'space.stars', 18, 'active', 1, null),
  ('space.stars.measurement', 'facet', 'space.stars', 19, 'active', 1, null),
  ('space.exoplanets', 'topic', 'space', 20, 'active', 1, 1),
  ('space.exoplanets.detection', 'facet', 'space.exoplanets', 21, 'active', 1, null),
  ('space.exoplanets.habitability', 'facet', 'space.exoplanets', 22, 'active', 1, null),
  ('space.exoplanets.diversity', 'facet', 'space.exoplanets', 23, 'active', 1, null),
  ('space.black-holes', 'topic', 'space', 24, 'active', 1, 1),
  ('space.black-holes.formation', 'facet', 'space.black-holes', 25, 'active', 1, null),
  ('space.black-holes.horizon', 'facet', 'space.black-holes', 26, 'active', 1, null),
  ('space.black-holes.evidence', 'facet', 'space.black-holes', 27, 'active', 1, null),
  ('machine-learning', 'system', null, 28, 'active', 1, null),
  ('machine-learning.attention', 'topic', 'machine-learning', 29, 'active', 1, 1),
  ('machine-learning.attention.mechanism', 'facet', 'machine-learning.attention', 30, 'active', 1, null),
  ('machine-learning.attention.example', 'facet', 'machine-learning.attention', 31, 'active', 1, null),
  ('machine-learning.attention.limits', 'facet', 'machine-learning.attention', 32, 'active', 1, null),
  ('machine-learning.transformers', 'topic', 'machine-learning', 33, 'active', 1, 1),
  ('machine-learning.transformers.architecture', 'facet', 'machine-learning.transformers', 34, 'active', 1, null),
  ('machine-learning.transformers.embeddings', 'facet', 'machine-learning.transformers', 35, 'active', 1, null),
  ('machine-learning.transformers.generation', 'facet', 'machine-learning.transformers', 36, 'active', 1, null),
  ('machine-learning.training', 'topic', 'machine-learning', 37, 'active', 1, 1),
  ('machine-learning.training.optimization', 'facet', 'machine-learning.training', 38, 'active', 1, null),
  ('machine-learning.training.examples', 'facet', 'machine-learning.training', 39, 'active', 1, null),
  ('machine-learning.training.generalization', 'facet', 'machine-learning.training', 40, 'active', 1, null),
  ('machine-learning.efficiency', 'topic', 'machine-learning', 41, 'active', 1, 1),
  ('machine-learning.efficiency.long-inputs', 'facet', 'machine-learning.efficiency', 42, 'active', 1, null),
  ('machine-learning.efficiency.sparsity', 'facet', 'machine-learning.efficiency', 43, 'active', 1, null),
  ('machine-learning.efficiency.tokens', 'facet', 'machine-learning.efficiency', 44, 'active', 1, null),
  ('human-body', 'system', null, 45, 'active', 1, null),
  ('human-body.heart-and-blood', 'topic', 'human-body', 46, 'active', 1, 1),
  ('human-body.heart-and-blood.pumping', 'facet', 'human-body.heart-and-blood', 47, 'active', 1, null),
  ('human-body.heart-and-blood.pressure', 'facet', 'human-body.heart-and-blood', 48, 'active', 1, null),
  ('human-body.heart-and-blood.oxygen', 'facet', 'human-body.heart-and-blood', 49, 'active', 1, null),
  ('human-body.nervous-system', 'topic', 'human-body', 50, 'active', 1, 1),
  ('human-body.nervous-system.signal', 'facet', 'human-body.nervous-system', 51, 'active', 1, null),
  ('human-body.nervous-system.synapse', 'facet', 'human-body.nervous-system', 52, 'active', 1, null),
  ('human-body.nervous-system.reflex', 'facet', 'human-body.nervous-system', 53, 'active', 1, null),
  ('human-body.immune-system', 'topic', 'human-body', 54, 'active', 1, 1),
  ('human-body.immune-system.innate', 'facet', 'human-body.immune-system', 55, 'active', 1, null),
  ('human-body.immune-system.adaptive', 'facet', 'human-body.immune-system', 56, 'active', 1, null),
  ('human-body.immune-system.memory', 'facet', 'human-body.immune-system', 57, 'active', 1, null),
  ('computing', 'system', null, 58, 'active', 1, null),
  ('computing.web-requests', 'topic', 'computing', 59, 'active', 1, 1),
  ('computing.web-requests.naming', 'facet', 'computing.web-requests', 60, 'active', 1, null),
  ('computing.web-requests.secure-transport', 'facet', 'computing.web-requests', 61, 'active', 1, null),
  ('computing.web-requests.caching', 'facet', 'computing.web-requests', 62, 'active', 1, null),
  ('computing.browsers', 'topic', 'computing', 63, 'active', 1, 1),
  ('computing.browsers.rendering', 'facet', 'computing.browsers', 64, 'active', 1, null),
  ('computing.browsers.event-loop', 'facet', 'computing.browsers', 65, 'active', 1, null),
  ('computing.browsers.same-origin', 'facet', 'computing.browsers', 66, 'active', 1, null),
  ('computing.algorithms', 'topic', 'computing', 67, 'active', 1, 1),
  ('computing.algorithms.growth', 'facet', 'computing.algorithms', 68, 'active', 1, null),
  ('computing.algorithms.sorting', 'facet', 'computing.algorithms', 69, 'active', 1, null),
  ('computing.algorithms.hashing', 'facet', 'computing.algorithms', 70, 'active', 1, null),
  ('history', 'system', null, 71, 'active', 1, null),
  ('history.industrial-revolution', 'topic', 'history', 72, 'active', 1, 1),
  ('history.industrial-revolution.causes', 'facet', 'history.industrial-revolution', 73, 'active', 1, null),
  ('history.industrial-revolution.technology', 'facet', 'history.industrial-revolution', 74, 'active', 1, null),
  ('history.industrial-revolution.consequences', 'facet', 'history.industrial-revolution', 75, 'active', 1, null),
  ('history.industrial-revolution.interpretation', 'facet', 'history.industrial-revolution', 76, 'active', 1, null);
insert into content.concept_node_revisions (node_id, revision, introduced_in, label, meaning, meaning_sha256, compatible_with, system_units, planet_units, planet_facets, scene_family, haze) values
  ('earth', 1, 1, 'Earth', 'Physical processes of Earth and its astronomical setting.', '78bdfd8c69fea6c6820d491079405b6d3e5668e5fbcd5f69433fdc12ce989253', '{}', 2, null, null, 'terraced.v1', 'amber'),
  ('earth.seasons', 1, 1, 'Seasons', 'Seasonal changes caused by axial tilt and orbital geometry.', '685240ee723e06ceae3cbf9934d820c43febb1b3a199ad2edd24380ef5380645', '{}', null, 3, 2, null, null),
  ('earth.seasons.axial-tilt', 1, 1, 'Axial tilt', 'Axial tilt changes solar angle and daylight through the year.', '8a3b0c0b887431c2110e3b6bac3b0f8dafb33aea962a6dd58bd4bece7bb92582', '{}', null, null, null, null, null),
  ('earth.seasons.hemispheres', 1, 1, 'Hemispheres', 'Opposite hemispheres experience contrasting seasonal illumination.', '3370fdde09e3cb3e928ee12797aa4423681c7fb35cc327e6a794625625c17979', '{}', null, null, null, null, null),
  ('earth.seasons.limits', 1, 1, 'Limits', 'Limits of simplified seasonal geometry, including the distance misconception.', '1b6ac8db936f90c45850e764b1676c1af0353545713d55129c32dbfeebf76994', '{}', null, null, null, null, null),
  ('earth.seasons.elsewhere', 1, 1, 'Elsewhere', 'Other planets have seasons too, set by their own tilt and orbit.', '5e48434a5ef524bed76a803bf9cd68d43e6b90417e2761ea9702d5ca4935df9f', '{}', null, null, null, null, null),
  ('earth.tides', 1, 1, 'Tides', 'Ocean tides under differential gravitational forcing and local conditions.', 'c743659294baffefd55b1915063b4847c396f2c9195243d772654d854102370d', '{}', null, 3, 2, 'archipelago.v1', null),
  ('earth.tides.forcing', 1, 1, 'Forcing', 'Differential lunar and solar gravity contributes to tidal forcing.', 'cbab21d356c4c2c31020b49214b1e0525f331ca7d49b2d81abc6ae6048c19726', '{}', null, null, null, null, null),
  ('earth.tides.alignment', 1, 1, 'Alignment', 'Sun and Moon alignment changes the combined tidal forcing.', 'cbdee9098ba2eb21f21c76e8a450122fc0a5df0b4f52c004e000ab93a756c2f3', '{}', null, null, null, null, null),
  ('earth.tides.coasts', 1, 1, 'Coasts', 'Coastlines and basin dynamics limit simple global tide predictions.', '9dbb5e83c11fea1f79b1abef712145226373a7b911b881e992192cd91e70470e', '{}', null, null, null, null, null),
  ('earth.greenhouse-effect', 1, 1, 'Greenhouse effect', 'Atmospheric absorption and emission in Earth radiation balance.', '0eaf4c6fcc2142b9c1fcb92a19a92c0628e989d473e162f46a57b827bc7211c4', '{}', null, 3, 2, 'ridged.v1', null),
  ('earth.greenhouse-effect.radiation', 1, 1, 'Radiation', 'Greenhouse gases absorb and emit infrared radiation.', '82d22a3482a1870ee7df27cdf991b1e83eeb3da25e73643bfcfdceef57aaf95f', '{}', null, null, null, null, null),
  ('earth.greenhouse-effect.balance', 1, 1, 'Balance', 'Surface temperature changes until incoming and outgoing energy balance.', '036ce7e31ac7487b275a614ccd97ee11d0a24bcd7f9830ac942ab8a8d3fdb84b', '{}', null, null, null, null, null),
  ('earth.greenhouse-effect.limits', 1, 1, 'Limits', 'The blanket analogy has limits and gases do not create energy.', '74a261b40cc9fdac89dd513d2185723e0c3d488f9f886385adc1134ec71c7fe0', '{}', null, null, null, null, null),
  ('space', 1, 1, 'Space', 'Stars, planets and black holes, and the methods astronomers use to study them.', 'c5ef051e5c6711eba315eee5495a19b0b23cf668fbc61c0fcf4a9f845f3112d1', '{}', 2, null, null, 'archipelago.v1', 'violet'),
  ('space.stars', 1, 1, 'Stars', 'How stars shine, how their mass shapes their lives and how they are measured.', '846fa0162430dc015871a1bf1385d853b31b4c905bf65c2cd200ed2532f39381', '{}', null, 3, 2, 'terraced.v1', null),
  ('space.stars.fusion', 1, 1, 'Fusion', 'Fusion in the core powers a star while gas pressure balances gravity.', '79a1935a67bea0f4bbafd912ab245e82e22a256ba17841535b08bc27525435f4', '{}', null, null, null, null, null),
  ('space.stars.lifecycle', 1, 1, 'Lifecycle', 'A star’s mass sets how it ages and how it ends.', '2f48c0aeba507c21de0d16b361ab38b79b824b2ff226cb2dbf53fc3e1c86caa1', '{}', null, null, null, null, null),
  ('space.stars.measurement', 1, 1, 'Measurement', 'Colour and brightness tell astronomers a star’s temperature, size and kind.', '8955431d4e52242007a398bfdfb6da27163aba5a1ffa040b6bd83958e5704efe', '{}', null, null, null, null, null),
  ('space.exoplanets', 1, 1, 'Exoplanets', 'Planets orbiting other stars, how they are found and what they are like.', '6e07bc0bad204fed9c7ab47972a914868db3368d207d757fe96aa40d1f508184', '{}', null, 3, 2, null, null),
  ('space.exoplanets.detection', 1, 1, 'Detection', 'Most exoplanets are found indirectly, through their effect on starlight.', 'd2e18057297a5c5dbf8e3f3e51975602ebbb5bf8c84e55a320ca4b572638a31b', '{}', null, null, null, null, null),
  ('space.exoplanets.habitability', 1, 1, 'Habitability', 'Whether liquid water could exist on a planet depends on starlight and many other factors.', '69e9975c103b3e09cfe867232b60b6a16287896e49165f00f37b8ea4e9faf69c', '{}', null, null, null, null, null),
  ('space.exoplanets.diversity', 1, 1, 'Diversity', 'Worlds around other stars include kinds with no counterpart in the Solar System.', 'e91a488b7c67a1613b64265b2a99d9021768de2ac11bf328ed8d6e2169ba2a33', '{}', null, null, null, null, null),
  ('space.black-holes', 1, 1, 'Black holes', 'Regions where gravity is so strong that nothing, not even light, can return.', '2568e96c611641bf5a1bdcd26379a191af7d1616756835d1184a3241697149c3', '{}', null, 3, 2, 'ridged.v1', null),
  ('space.black-holes.formation', 1, 1, 'Formation', 'Black holes form when massive stars collapse, and some grow far larger by other routes.', '7e19ae4b1a36e2bb821fa4691eb4a37d2adc96243afb40b74f6170c4fa1990df', '{}', null, null, null, null, null),
  ('space.black-holes.horizon', 1, 1, 'Horizon', 'The event horizon is the boundary beyond which nothing can escape.', 'b37e9ad56b347cbd33de90fae309bb126616132bb9a558459a7ea46a6ad8a349', '{}', null, null, null, null, null),
  ('space.black-holes.evidence', 1, 1, 'Evidence', 'Black holes are known from their effects on stars, gas and spacetime, not by direct sight.', 'fff81535c4251b3371f8a8c57dfa1e815d9949063e534629f8d9ba7ab299d533', '{}', null, null, null, null, null),
  ('machine-learning', 1, 1, 'Machine learning', 'How computers learn patterns from data, and how modern language models work.', '95498d6029f5f1e4a5acc22a8082a8ac9a2ec3c64864c86a1ae99fcd9858d38f', '{}', 2, null, null, 'ridged.v1', 'teal'),
  ('machine-learning.attention', 1, 1, 'Attention', 'Attention lets a model weigh which parts of its input matter for each part of its output.', '838c24c38e9188034ead140e251b0b61847b49f7601f681f54fe386138bdcc89', '{}', null, 3, 2, 'terraced.v1', null),
  ('machine-learning.attention.mechanism', 1, 1, 'Mechanism', 'Queries, keys and values turn similarity scores into weights over the input.', '65ef7d5e3d990ac71eded53c8cccc261d25bcc3c0d9bf893343b903937013f0a', '{}', null, null, null, null, null),
  ('machine-learning.attention.example', 1, 1, 'Example', 'A worked case shows which input words a model weighs when producing each output word.', '936bf9f15b127baa7bc130e10501f032de195b48c981129bc4bda90a58b111cf', '{}', null, null, null, null, null),
  ('machine-learning.attention.limits', 1, 1, 'Limits', 'Attention weights are not a full explanation, and attention has its own costs.', '9c9710eb743d662de3711f8dd4ab6dfc766c89fbb4c03d04db355dab263bd18f', '{}', null, null, null, null, null),
  ('machine-learning.transformers', 1, 1, 'Transformers', 'The transformer is the network design behind most modern language models.', '36bb67608e1a18558fe84a35daf48675523b5b4b27cfadb49240d1782f6b965f', '{}', null, 3, 2, null, null),
  ('machine-learning.transformers.architecture', 1, 1, 'Architecture', 'A stack of similar blocks combines attention with feed-forward layers.', '0285dad7ac53c1e2fab50c62356a0fd0516c83c3b18792d7d37ca2610d87a784', '{}', null, null, null, null, null),
  ('machine-learning.transformers.embeddings', 1, 1, 'Embeddings', 'Tokens become vectors whose geometry carries part of their meaning.', 'a39d20ef462bdf3d7fb9d0d7654d910b46f935e576e7e0be4490e1d64c6eda31', '{}', null, null, null, null, null),
  ('machine-learning.transformers.generation', 1, 1, 'Generation', 'A language model writes text by predicting one token at a time.', '9e18a49c79ce06885b11adb67086b5022de13bcc939d7833c38d4904024daa5f', '{}', null, null, null, null, null),
  ('machine-learning.training', 1, 1, 'Training', 'Training adjusts a network’s numbers from data so that its predictions improve.', 'f03d26c2f174d5c8999fb0b38645cf61aded8bf5ff609e3d43c59320af890707', '{}', null, 3, 2, 'archipelago.v1', null),
  ('machine-learning.training.optimization', 1, 1, 'Optimization', 'Gradient descent nudges parameters in the direction that lowers a loss.', '49b939aa18bdd10197c80ddbdb67aff4d11eb410de60ac1c9d27e2f6218c3aa1', '{}', null, null, null, null, null),
  ('machine-learning.training.examples', 1, 1, 'Examples', 'Training examples strengthen or weaken the connections between a network’s units.', '9bd257b31ffe82ccb7880bd280d4a17589ba1123c61f5bab0b66ce86c412e99d', '{}', null, null, null, null, null),
  ('machine-learning.training.generalization', 1, 1, 'Generalization', 'A useful model does well on new data, not only on the data it learned from.', '67c40992c7384eee0cb56552d91bbae45cff4ac0bfb80d58667eb4a1a2db2847', '{}', null, null, null, null, null),
  ('machine-learning.efficiency', 1, 1, 'Efficiency', 'Designs and encodings that keep large models affordable to train and run.', '365f4a550473e4d3360c758ee2b29b7c5a07cbf2bb59b8d8a1109c4a28f6a221', '{}', null, 3, 2, 'terraced.v1', null),
  ('machine-learning.efficiency.long-inputs', 1, 1, 'Long inputs', 'Attention cost and memory grow quickly with input length, and designs reduce them.', 'd3aa2a0ddd8bae5099c4680b9e79bd6a1b88c216910f5d4c0f437ab612cc13d9', '{}', null, null, null, null, null),
  ('machine-learning.efficiency.sparsity', 1, 1, 'Sparsity', 'Mixture of experts uses only part of a model for each input.', '9f1da6d4910c43da30f8047e21b9d29f68edf91bd48c262d9b600ef12d132823', '{}', null, null, null, null, null),
  ('machine-learning.efficiency.tokens', 1, 1, 'Tokens', 'Subword tokenization turns text into a manageable vocabulary of pieces.', 'd86017c48b4e1f16323f4d421762fa99009ab27c5b22f0f3b38c8d59b12c8623', '{}', null, null, null, null, null),
  ('human-body', 1, 1, 'Human body', 'How the organs and systems of the human body work.', '13eeeeb9fcbccdb34787a923b5fd16274346484425a127eda2be93af5ee00bb6', '{}', 2, null, null, 'archipelago.v1', 'coral'),
  ('human-body.heart-and-blood', 1, 1, 'Heart and blood', 'The heart and blood vessels move blood, and with it oxygen, around the body.', '2a6eca27ca5707a517e08387d850e7c3ac9233d4dbf3c2dcf2d0272e8f2c3449', '{}', null, 3, 2, 'ridged.v1', null),
  ('human-body.heart-and-blood.pumping', 1, 1, 'Pumping', 'The heart’s chambers and valves pump blood in a repeating cycle.', '82ed0afa0b9dc2f566f07dc30b68d0f1ca60c94603cd186ff9e9d65e4acd5bee', '{}', null, null, null, null, null),
  ('human-body.heart-and-blood.pressure', 1, 1, 'Pressure', 'Blood pressure depends on the heart’s output and on how much the vessels resist flow.', 'ac8fec6f089491ed14454970c0c2ad1b47170b4212801427ea78428d7aea799a', '{}', null, null, null, null, null),
  ('human-body.heart-and-blood.oxygen', 1, 1, 'Oxygen', 'Haemoglobin picks up oxygen in the lungs and releases it where it is needed.', '030f768cab220fe8787c1c00bc7330d683562ba8eb4e3d800488c9e18f097144', '{}', null, null, null, null, null),
  ('human-body.nervous-system', 1, 1, 'Nervous system', 'Nerve cells send signals along their length and between one another.', '29623c2ee4a64bf38dfeb0f8809d97d902cd27b514e47d29cdd7baf98fd3ac2a', '{}', null, 3, 2, null, null),
  ('human-body.nervous-system.signal', 1, 1, 'Signal', 'A nerve cell fires a brief electrical impulse, an action potential, along its length.', 'f66e659ab0c39c827778c2c7263ddf50efd4496825b16d722498b0c086f8589f', '{}', null, null, null, null, null),
  ('human-body.nervous-system.synapse', 1, 1, 'Synapse', 'Chemical messengers carry the signal across the gap between two cells.', '61477381e4af36853d3ca036a48c49c571193e5b538afffbe00530f33f6f32e4', '{}', null, null, null, null, null),
  ('human-body.nervous-system.reflex', 1, 1, 'Reflex', 'Short circuits through the spinal cord produce fast, automatic responses.', '05f4e5b06ea89810326fad1f80a50d2b440e1b21e401b7fde63b60a5b3a1cb94', '{}', null, null, null, null, null),
  ('human-body.immune-system', 1, 1, 'Immune system', 'The immune system recognises and responds to threats such as infections.', 'd27b500ea7720a6fcc7acf1491658790c6bed9bd24dde3c5186c56e9a136d2be', '{}', null, 3, 2, 'terraced.v1', null),
  ('human-body.immune-system.innate', 1, 1, 'Innate', 'Fast, general defences respond within hours without earlier exposure.', 'd1d824fc3801662aa45e768e201c0e1aa662406c23ec055b5466686134cfb9d4', '{}', null, null, null, null, null),
  ('human-body.immune-system.adaptive', 1, 1, 'Adaptive', 'Lymphocytes learn a specific threat and tailor a response to it.', 'da076ee680489f319e592c3c27b64b655d420a848424f731d62f3473d855531d', '{}', null, null, null, null, null),
  ('human-body.immune-system.memory', 1, 1, 'Memory', 'After exposure or vaccination, memory cells let the next response start faster.', 'b4ffb8bb1ae3f6c69eed1ad273358a19fa61162301e267f155f9f5d79b7e4ec6', '{}', null, null, null, null, null),
  ('computing', 1, 1, 'Computing', 'How the web, browsers and everyday algorithms work.', '252c66d1313f3d290eec153126342085001239676f1228864d3303751fa6386b', '{}', 2, null, null, 'terraced.v1', 'cobalt'),
  ('computing.web-requests', 1, 1, 'Web requests', 'What happens between typing an address and seeing a page.', '324a2dabf66f04f9107de8e492b4cdfd38f683faf5bf92fd9843fc5c114d1574', '{}', null, 3, 2, 'archipelago.v1', null),
  ('computing.web-requests.naming', 1, 1, 'Naming', 'The Domain Name System turns a name into the address of a server.', '5550ecb8d5e6e1db1be53a2de06722b7e19efa7bdafa806993f4b83d68ac900c', '{}', null, null, null, null, null),
  ('computing.web-requests.secure-transport', 1, 1, 'Secure transport', 'A secure connection lets a browser and server exchange data privately.', '1da5bce579993a997de1c530745cfe87874c237fe4af27936abeb43b118bcf3c', '{}', null, null, null, null, null),
  ('computing.web-requests.caching', 1, 1, 'Caching', 'Caches reuse earlier responses to save time and traffic.', 'f65fe9af5d240ef5e9f6b0180b061aed4023ee945374dfde1d277e7ae99e92a1', '{}', null, null, null, null, null),
  ('computing.browsers', 1, 1, 'Browsers', 'How a browser turns code into a page you can use.', '4c378584a8689fdc1f10682210b4cab89e3c7fe05cd898409b8a6f5a1d954103', '{}', null, 3, 2, null, null),
  ('computing.browsers.rendering', 1, 1, 'Rendering', 'Parsing, styling, layout and painting turn markup into pixels.', '2b7abf38165161e46aed6e13e11004cbcc2cf25aedf571d0cad5cbc793d83bab', '{}', null, null, null, null, null),
  ('computing.browsers.event-loop', 1, 1, 'Event loop', 'Scripts run one task at a time, and events wait their turn.', '1bf784400413801b92ac2e9054d0f816ff9d7dcf74049cd8091d8d4f6474aed8', '{}', null, null, null, null, null),
  ('computing.browsers.same-origin', 1, 1, 'Same origin', 'The same-origin policy keeps one site’s pages from reading another’s data.', '906b4bc916f588a7e2777d97e957478045ed97918babcc1f888f99aef146f6a7', '{}', null, null, null, null, null),
  ('computing.algorithms', 1, 1, 'Algorithms', 'Ways of solving problems with code, and how their cost grows with the size of the problem.', '00ff1c89577287e6261370efb1590deb510192dab2f09a5c515a731349c02564', '{}', null, 3, 2, 'ridged.v1', null),
  ('computing.algorithms.growth', 1, 1, 'Growth', 'Cost is described by how the work grows with the size of the input.', 'c67d8b851f84110d8743fdefec2a2c6475e5bb534df774891aa760de25778623', '{}', null, null, null, null, null),
  ('computing.algorithms.sorting', 1, 1, 'Sorting', 'Different sorting strategies trade speed, memory and stability.', 'e149a2f5910f0b26507bc98e30067917f089dfaf552a3fb4fbb28227fbc54494', '{}', null, null, null, null, null),
  ('computing.algorithms.hashing', 1, 1, 'Hashing', 'Hash tables give fast lookups by turning keys into positions.', '758560ce3c27b351eba3b6a51e29503b00261a0344394e899450739da857c566', '{}', null, null, null, null, null),
  ('history', 1, 1, 'History', 'How past events and ideas shaped the world, told with their uncertainties.', '934331e0f4003f0680fd16af3a26650d9a69b63649cdbc15a3710d93e77eb914', '{}', 2, null, null, 'ridged.v1', 'pink'),
  ('history.industrial-revolution', 1, 1, 'Industrial revolution', 'The shift from hand tools and farms to machines and factories, beginning in Britain.', 'cac6a87225972cfd3edace44ecf4acf1c7efda75e0298a8930c8921e66321c16', '{}', null, 3, 2, null, null),
  ('history.industrial-revolution.causes', 1, 1, 'Causes', 'Why industrialisation began where and when it did, and which causes historians weigh.', '1582384db5748db5d3bff593738860e0c2f4208c7d657f2a75cf1f908029b757', '{}', null, null, null, null, null),
  ('history.industrial-revolution.technology', 1, 1, 'Technology', 'New machines and power sources changed how goods were made.', '25e30c1030b26a5510e72735888d1e4186980c68606e0ec252c6438dea6a0720', '{}', null, null, null, null, null),
  ('history.industrial-revolution.consequences', 1, 1, 'Consequences', 'Industrialisation changed where people lived and how they worked.', '04630a6a60956cf575ecabfcb942bda41938c8df7e958e4f945c9d8851fb7cb5', '{}', null, null, null, null, null),
  ('history.industrial-revolution.interpretation', 1, 1, 'Interpretation', 'Historians disagree about why and when Western Europe pulled ahead.', '0d975d79ea4677ff8d0d9a62bcca5cb4dfffee93845ef4e2baf69fd332dff95e', '{}', null, null, null, null, null);
insert into content.concept_current (singleton, release_id) values (true, 1);

-- Releases and revisions are immutable; a node's identity never changes and a row is never deleted; the pointer only moves forward.
create function content.concept_immutable() returns trigger language plpgsql as $$
begin
  raise exception using message = 'CONTENT_CONCEPT_IMMUTABLE', errcode = '23514';
end;
$$;

create trigger concept_releases_immutable before update or delete on content.concept_releases
for each row execute function content.concept_immutable();
create trigger concept_node_revisions_immutable before update or delete on content.concept_node_revisions
for each row execute function content.concept_immutable();

create function content.concept_node_monotonic() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception using message = 'CONTENT_CONCEPT_IMMUTABLE', errcode = '23514';
  end if;
  if new.node_id <> old.node_id or new.kind <> old.kind or new.parent_id is distinct from old.parent_id
     or new.seq <> old.seq or new.introduced_in <> old.introduced_in
     or (old.visible_in is not null and new.visible_in is distinct from old.visible_in)
     or (old.retired_in is not null and new.retired_in is distinct from old.retired_in)
     or (old.merged_into is not null and new.merged_into is distinct from old.merged_into) then
    raise exception using message = 'CONTENT_CONCEPT_IMMUTABLE', errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger concept_nodes_monotonic before update or delete on content.concept_nodes
for each row execute function content.concept_node_monotonic();

create function content.concept_current_monotonic() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and new.release_id < old.release_id) then
    raise exception using message = 'CONTENT_CONCEPT_CURRENT_STALE', errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger concept_current_monotonic before update or delete on content.concept_current
for each row execute function content.concept_current_monotonic();
