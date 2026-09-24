# ADR-0037 — Foundation Stars: a place that holds others up, by sourced connection alone

Date: 2026-09-24. Status: accepted for [#131](https://github.com/KnowScroll/knowscroll/issues/131)
(evidence-backed geography: "foundation Stars") and [#134](https://github.com/KnowScroll/knowscroll/issues/134),
parent #72. Builds on ADR-0036 (the reader's places) and ADR-0031 (substrate, relations, bridges).
Follows `docs/architecture/target/07-UNIVERSE-EVOLUTION.md` §1 (the `load_bearing` property).

## Decision

1. **What makes a foundation.** A live planet or region is load-bearing when its anchor explains,
   or is a prerequisite for, at least **three** things across at least **two** of the reader's
   other live planets or regions. Each connection must be an active substrate relation with its
   claim, or an admitted shared bridge; a claim and a bridge for the same connection count once.
   Direction matters: the foundation is the one doing the explaining. Sightings are not held up;
   they have not been met. The connection count only triggers the evaluation. Attention plays no
   part, so no amount of reading can buy the status.
2. **Recorded like every other change** (`cartographer-v2`). `foundation_recognised`
   (`substrate_neighbourhood`) carries the connections and the places they hold up;
   `foundation_withdrawn` carries the connections it had, with cause `source_correction` when one
   of them was revoked and `reader_correction` when the reader set a place aside. Setting a place
   aside re-evaluates foundations in the same transaction. The `load_bearing` flag changes only
   together with such a delta (the ADR-0036 trigger) and is never set on a sighting.
3. **Shown as a property, not an object.** The atlas returns, per place, `foundation: {holdsUp,
   relations}` or null. The chronicle says "Gravity holds up Orbits, Star formation and Tides.";
   the place sheet lists what it holds up and the claims that say so. The renderer may express it
   as brightness or pull lines. There is no separate star object.
4. **v2 changes nothing v1 decides.** Places, regions, sightings and rejection behave exactly as
   in ADR-0036; only the foundation step is new.

## Not in this version

A model-written explanation of what the places depend on; the target's "useful navigation role"
beyond "the held-up places are the reader's own"; limits beyond those the admitted bridges
already carry; galaxies and systems.

## Consequences

Migration 0031 (`load_bearing`, the two delta kinds); `packages/core/src/atlas/cartographer.ts`
step 4; `packages/db/src/atlas.ts` (apply, read, re-plan after rejection); the contract; Android
shows foundations on the marker and in the place sheet.
