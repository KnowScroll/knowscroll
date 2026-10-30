-- #465 (v3 U-1) The look of each place, assigned once: a planet's type, rings and moon, a system's haze, the
-- number of sites on a planet's world and the site each region takes (D-077, D-078, D-102).
--
-- Owner: scenes. Derived appearance, never formation, evidence or learning authority. It is a sibling of
-- scenes.objects because scenes.guard_object freezes everything in an object's payload but its label and activity,
-- and the descriptor stays scene-descriptor.v1 for clients that predate looks.
-- Query shapes: every look of a universe and epoch (to assign the next one and to serve a manifest read); the
-- planets of one universe by type (the assignment rule counts them in code over that read).
-- Constraints: one look per object, only for an object that is projected; a payload that names its own object and
-- kind; an update is refused, so a look can never be recomputed (SCENE_VERSION_IMMUTABLE, the scenes version guard).
-- Growth: at most one row per system, planet and region, so at most 1000 per universe and epoch (the projector's
-- object ceiling). Stars have none. No row is added for a place that is not projected.
-- Retention: erased with every other scenes table by full erasure and by selective Clear; exported with nothing,
-- like the objects it describes. Clear advances the privacy epoch, so a new universe assigns its looks afresh.
-- Rollout: additive. Older processes ignore the table and keep projecting without looks; the next projection of
-- this release assigns any that are missing, and the operator backfill reaches worlds that do not change.

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table scenes.looks (
  universe_id uuid not null references identity.universes (id) on delete restrict,
  privacy_epoch integer not null check (privacy_epoch > 0),
  object_id uuid not null,
  kind text not null check (kind in ('system', 'planet', 'region')),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and octet_length(payload::text) <= 1024
    -- is not distinct from: a payload without these keys must fail, and a plain = would pass on NULL.
    and payload ->> 'schemaVersion' is not distinct from 'scene-look.v1'
    and payload ->> 'objectId' is not distinct from object_id::text
    and payload ->> 'kind' is not distinct from kind
  ),
  primary key (universe_id, privacy_epoch, object_id),
  foreign key (universe_id, privacy_epoch, object_id)
    references scenes.objects (universe_id, privacy_epoch, object_id) on delete restrict
);

create trigger scene_look_immutable before update on scenes.looks
  for each row execute function scenes.guard_version();
