# ADR-0036 — The reader's places: geography that forms from anchored attention (Cartographer v1)

Date: 2026-09-24. Status: accepted for [#134](https://github.com/KnowScroll/knowscroll/issues/134)
(parent #72), first slice. Builds on ADR-0028 (worlds are shared sources; a system is what one
reader reached), ADR-0031 (substrate, typed relations, admitted bridges) and ADR-0032 (attention
accounts). Follows `docs/architecture/target/07-UNIVERSE-EVOLUTION.md` §2–§4.2, at bench values.

## Context

The live Android Atlas draws its regions and topics from authored geography
(`AuthoredGeography.kt`, "Illustrative geography…"). Worlds are one per source, which says where a
Scroll came from, not what it is about or how the reader's reading is organised. ADR-0032 already
computes, per concept, whether the reader's attention is `seen`, `anchored` or `dormant`, with its
evidence. Nothing turns that into places, and nothing records why a place exists.

## Decision

1. **Places.** `atlas_place` belongs to one universe and is anchored on one substrate concept: a
   `planet` (free), a `region` (inside a planet or region) or a `sighting` (an offer at the edge of a
   place). One live place per anchor per universe. States: `live`, `promoted` (a sighting that became
   a planet or region), `rejected` (the reader said no), `retired` (its basis went away).
2. **Deltas are the only way a place changes.** Every insert or update of a place is accompanied,
   in the same transaction, by an immutable `atlas_delta` (enforced by a deferred constraint
   trigger): kind, causal class, policy version, evidence, before and after. The Atlas shows
   deltas as a chronicle, and each opens to its evidence.
3. **Cartographer v1 (pure, `packages/core/src/atlas/cartographer.ts`).** Runs where attention is
   recomputed (after an exposure, keep, branch, Ask or correction; never while paused):
   - An `anchored` concept with no live place, never rejected, becomes a **region** of the nearest
     live planet/region whose anchor is its substrate ancestor within 2 parent hops, else a free
     **planet** (`place_formed`, causal class `personal_exploration`, evidence: the account's
     numbers and episode/mark ids). Shallower concepts are placed first, so a parent anchored in the
     same pass is a planet before its child becomes its region. A sighting of that concept is
     promoted.
   - Each live planet/region offers up to 5 **sightings**: concepts one active typed relation or
     admitted shared bridge away (any kind except the hierarchy), which the reader has never been
     shown, ranked by substrate degree (`sighting_appeared`, `substrate_neighbourhood`, evidence: the
     relation and its claim or bridge).
   - A live sighting whose relation or bridge is no longer active is **retired**
     (`sighting_retired`, `source_correction`). A sighting the reader has now been shown is
     retired as their own exploration (`personal_exploration`, "You came across …"); a sighting is only
     ever something not yet met, so it never carries attention. If it is already anchored it is
     promoted instead. The five-sighting cap counts the sightings a place already has; a sourced
     claim is preferred over a bridge as a basis, and degree counts distinct neighbours.
   - Places are never removed for fading attention in v1; `dormant` is shown, not acted on.
4. **The reader corrects.** `POST /v1/atlas/places/:placeId/reject` records `place_rejected`
   (`reader_correction`); its sightings retire and its regions are released as free planets
   (`place_released`). A rejected anchor never forms again until Clear/Reset. Refused while paused
   (nothing personal is recorded then).
5. **Read.** `GET /v1/atlas` returns live places with anchor, parent, basis, the anchor's account
   summary and Scroll counts (total/seen, by primary concept in the anchor's subtree that is not
   itself a place), the typed relations between live places with their claims or bridges, and the
   latest chronicle lines. `GET /v1/atlas/deltas/:deltaId` returns one delta's evidence.
6. **Privacy.** Places and deltas are private history: Clear and Reset erase them, export carries
   them, account deletion (ADR-0035) removes them with the rest.

## Not in v1

Numeric gates beyond `anchored`, hysteresis and rate limits (target §3 step 7), identity matching,
naming by a model (step 5), foundation stars (`load_bearing`), rooms, relics, away-time work,
30-day sighting expiry, Leiden. Each is a later slice with its own version. Thresholds are bench
values carried by `cartographer-v1`.

## Consequences

Migration 0029 (`atlas_place`, `atlas_delta`, guards); `packages/core/src/atlas/cartographer.ts`;
`packages/db/src/atlas.ts`; the refresh hook in `packages/db/src/semantic/personal-model.ts`; API
routes and contracts; Clear/Reset/export; Android's live Atlas reads places instead of authored
regions (authored geography stays for the labelled preview only).
