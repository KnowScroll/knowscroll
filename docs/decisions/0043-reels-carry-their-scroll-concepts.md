# ADR-0043 — A Reel carries its Scroll's concepts, explains itself and continues like a Scroll

Date: 2026-09-24. Status: accepted by the coordinator for [#167](https://github.com/KnowScroll/knowscroll/issues/167)
(parent #133). Builds on ADR-0023 (a Reel is minted from an editorial brief over one library Scroll),
ADR-0024 (publication gates), ADR-0025 (a gated Reel is inventory), ADR-0031 (asset annotations),
ADR-0032 (the semantic Composer, its recorded explanation and "less like this") and ADR-0036 (places).

## Context

The v3 Composer reads what an encounter is about from `asset_concept`. Only editorial Scrolls are
annotated (by the substrate seed), so a minted Reel has no concepts: it can only be served as
`fallback`, its exposure and keep credit no attention account, nothing continues from it and its
"why" can only say it was not mapped. Android's Reel reader has no "why" at all, and its
continuations are never loaded outside the authored preview.

A Reel is not about something new. Its brief (ADR-0023) is authored over exactly one library Scroll
at a pinned revision, and its `source_support` gate (ADR-0024) proves every narration claim maps to
that Scroll. What the Scroll is about is therefore what the Reel is about.

## Decision

1. **Minting copies the source Scroll's concepts, with the same roles.** `mintReelAsset` inserts the
   Reel asset and, in the same transaction, one `asset_concept` row per annotation of the brief's
   `source_asset_id` (`primary`, `secondary`, `mentioned` unchanged). An unannotated Scroll gives an
   unannotated Reel, served honestly as `fallback`. The Scroll's `asset_claim` rows are **not**
   copied: the brief's claims are its own narration claims mapped to the Scroll, and a Reel may
   present only some of the Scroll's substrate claims, so it must not be offered as the `challenge`
   of a contradiction it might not state, or counted as restating an argument it might not make.
2. **No migration and no backfill.** Annotations stay immutable and follow the asset (migration
   0026). A Reel asset can exist only in a disposable `knowscroll_test_*` database (the ADR-0024
   stand-in fence and the unavailable witness gate), so no persistent database holds an unannotated
   Reel to backfill.
3. **Everything downstream is unchanged code reading the same rows.** The Composer treats a Reel's
   concepts exactly as a Scroll's (families, the seen penalty, novelty, fatigue, the no-adjacent-repeat
   rule, per-concept diversity; a Reel shares its source key with its Scroll, so per-source diversity
   holds too). Attention accounts and hypotheses credit Reel exposures and keeps. `GET
   /v1/decisions/:id/why` returns a Reel's recorded family, reason (naming its concept) and evidence
   path, and "less like this" suppresses its route. `GET /v1/assets/:id/branches` offers continuations
   from a Reel's primary and secondary concepts; the targets stay Scrolls. The atlas's per-place
   `scrolls` counts are restricted to Scrolls, so an annotated Reel never inflates them.
   One loader fix was needed and is not a ranking change: the Composer's state described only the
   kinds the client asked for, so a Reel kept in Reel mode was invisible to Scroll mode (and a Scroll
   kept in Scroll mode to Reel mode). The state now also describes, as `history`, the encounters the
   reader's exposures and marks name outside the requested kinds; they ground families, fatigue and
   the no-adjacent-repeat rule, and are never offered. A history of the requested kinds only (every
   universe before Reels) composes exactly as before, with the same `composer-semantic-v3` row.
4. **A Reel whose Scroll lost support follows the existing gates.** Its brief pins the Scroll's
   revision; `source_support` fails closed when that revision changes, and a withdrawn Reel asset is
   never offered. Automatic withdrawal after a correction remains the later correction-propagation
   slice (ADR-0024 §5); this ADR adds nothing that keeps a Reel alive past its gates.
5. **Android: the Reel reader explains itself and continues.** A "Why" control on the Reel opens the
   Scroll reader's own why sheet (the same composable, the same recorded data and the same
   corrections), worded for a Reel. Its continuations are the same live `GET …/branches` list, shown in
   the existing "Continue →" rail and taken by the horizontal swipe; a continuation opens its Scroll
   with the Reel as its origin, and Back returns to the Reel at its position. Per the owner's decision
   of 2026-09-24, the sheet shows no source: no source names, publishers, URLs, licences or counts.
   The authored preview has no recorded decision, so it shows no "Why".
6. **Policy tuning is evidence-led and versioned.** `scripts/composer-compare.ts` walks golden and
   adversarial readers over a library that includes gated test Reels (one over several library
   Scrolls): the two interest readers, a Reel-heavy reader, a reader who only skips, a reader with one
   narrow interest, and a cold start. It reports, besides the existing measures, whether a Reel and its
   own Scroll are served back to back or in one slate. A policy change is made only for a defect the
   comparison shows, as a new registered, immutable policy version compared in shadow against
   `composer-semantic-v3` by the same script; v3 is never edited (ADR-0032 §4).

## Alternatives and why

- *Annotate Reels in the substrate seed:* a Reel asset id does not exist until publication, and the
  seed would have to be edited per mint.
- *A database trigger on Reel insert:* the same rows with more machinery; minting has one path and
  already runs its checks there.
- *Copy the Scroll's claims too:* over-claims what a Reel states (Decision 1).
- *A separate Reel explanation route or sheet:* duplicates the recorded-why contract the Composer
  already writes for every served encounter.

## Consequences

`apps/worker/src/publication/mint.ts` (transactional mint with annotations); `packages/db/src/atlas.ts`
(Scroll-only counts); a shared test fixture that mints a gated test Reel over a given Scroll
(`scripts/fixtures/gated-reel.ts`, also used by `scripts/fixtures/native-reel.ts`, which can now mint
over a library Scroll for a hands-on stack); Android `ui/reel/ReelScreen.kt`, the why sheet's wording
and the live reader's wiring; `scripts/composer-compare.ts`. Tests: pure Composer golden, adversarial
and replay cases with Reels; DB/API: a minted Reel's concepts, its why and path, a continuation from
it, the atlas count; Android: the Reel why sheet and that it renders no source text.
