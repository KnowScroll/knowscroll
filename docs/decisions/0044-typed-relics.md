# ADR-0044 — Typed Relics: a place, a passage and an answer; the return's follow-ups

Date: 2026-09-25. Status: accepted by the coordinator for [#165](https://github.com/KnowScroll/knowscroll/issues/165)
(parent #134, under #72). Builds on ADR-0033 (Ask answers), ADR-0036/0037 (the reader's places),
ADR-0039 (the return and connection Relics, with its amendment: readers never see a source) and
ADR-0040 (a correction reaches places while the reader is away). Also settles the deferred review
items of [#159](https://github.com/KnowScroll/knowscroll/issues/159) (M4–M8).

## Context

ADR-0039 made the first Relic: a kept connection whose state shows a later correction or the
reader's doubt. The product promises more (`docs/product/definition.md`, "Relic is not Scroll"):
a person keeps what mattered to them — a place in their universe, a moment of a Scroll, an answer
to their own question — and each keeps its provenance and shows it when what it rests on changes.

The review of ADR-0039 also left five follow-ups (#159): a reader's "seems wrong" is forgotten when
the process dies (M5); a long correction can commit behind a marker (M6); items beyond the first ten
of the return can never be seen (M7); the Relic list stops at 100 without saying so, and two
accessibility defects (M8); and a withdrawn basis looks like a current one (M4, reinterpreted now
that readers never see a source).

## Decision

1. **Four kinds, one contract.** A Relic is `connection` (ADR-0039), `place`, `passage` or
   `answer`. Every kind is immutable, private history of one universe and epoch (Clear, Reset and
   account deletion erase it; export carries it with its provenance), kept only while recording
   (`POST /v1/relics` is refused while paused, and the database refuses the row), idempotent by
   client request id (a key reused for another thing is 409), one per thing per epoch (keeping it
   again answers 200 with the Relic already kept), and refused (422) for something the reader has
   doubted. Provenance is recorded by the server at keep time, never taken from the client.

2. **What each kind keeps, and what corrects it.**

   | Kind | Kept | Provenance recorded at keep time | Corrected when | Doubted when |
   |---|---|---|---|---|
   | `connection` | an admitted bridge this universe can see | ADR-0039 §3 | the bridge is revoked or superseded | the reader marked it "seems wrong" (ADR-0031 feedback) |
   | `place` | one of the reader's live places (planet, region or sighting) | the place, its anchor and kind, and the delta that formed it (`place_formed` or `sighting_appeared`, whose evidence says why) | a delta caused by a source correction was recorded for the place after it was kept (a sighting whose relation was revoked, a foundation recognised again or withdrawn by a correction) | the reader set the place aside (ADR-0036 reject) |
   | `passage` | one claim of a Scroll the reader read in this epoch, as they read it | the Scroll, its revision and title from the exposure's recorded selection (it must still be the current revision), the claim, and that exposure | the Scroll has a newer revision, or the claim lost its current support | the reader's "seems wrong" on that claim of that Scroll |
   | `answer` | an `answered` Ask answer of this universe and epoch (ADR-0033) | the Ask (the answer's id), the Scroll and revision it was answered from (the Ask's exposure; still current), and the claims that Scroll presented with current support | the Scroll has a newer revision, or one of those claims lost its support | the reader's "seems wrong" on the answer |

   A passage or answer resting on a claim that was already unsupported is not kept (422); a Scroll
   revised since it was read or answered is not kept (409). A place that is no longer live is not
   kept (422).

3. **State is derived when read, by one rule.** The database gathers each kind's facts; a pure
   function (`packages/core/src/relics.ts`) decides: **corrected beats doubted, which beats
   current.** Nothing is deleted or hidden by a correction: the kept form stays readable (a
   connection's sentence and claims, a place's name and the line that formed it, a passage's Scroll
   title and claim, an answer's question, answer, basis quotes and limits — all immutable rows).

4. **The reader's "seems wrong" on a passage or an answer** is a new private objection:
   `POST /v1/objections {clientRequestId, expectedPrivacyEpoch, kind: 'passage', assetId, claimKey}`
   or `{…, kind: 'answer', askId}`. It is idempotent, needs a Scroll the reader read (passage) or an
   answered Ask (answer), is refused while paused like every new personal record here, and is
   personal: it never retracts shared knowledge. A place is doubted with the existing "Set aside";
   a connection with the existing `POST /v1/connections/feedback`.

5. **Where the reader meets each kind** (Android), with Keep and "Seems wrong" offered only while
   recording (a line says why otherwise): the place sheet (Keep; doubt is "Set aside"); the Scroll
   reader's "Passages" sheet, from `GET /v1/scrolls/:assetId/passages` (the Scroll's claims with
   their state for this reader: `withdrawn`, `kept`, `seemsWrong`); and an answered Ask, whose view
   (`GET /v1/asks/:askId/answer`) now also says `kept` and `seemsWrong`. Keep lists every kind with
   its state; each opens its kept form with "Let go".

6. **Readers never see a source** (ADR-0039 amendment). `place`, `passage` and `answer` Relics,
   passages and objections carry only the kept form and its state: no source, publisher, URL or
   count, and none of the provenance recorded for them (exposure, formation delta, cited claims).
   That stays internal; the export carries it. A `connection` Relic keeps its ADR-0039 wire, whose
   client already shows no source.

7. **The #159 follow-ups.**
   - **M4, a withdrawn basis is marked.** Every evidence claim of a connection (found, corrected or
     kept) says `withdrawn` when it no longer has current support, and so does a passage's claim —
     never which source was withdrawn.
   - **M5, "seems wrong" survives the process.** `connection_found` and `connection_corrected` away
     items carry `seemsWrong`: whether this reader objected to that bridge.
   - **M6, commit order.** Every away item's time is taken under a lock that `GET /v1/away` also
     takes before it reads: inquiry outcomes and place changes are written under the universe lock,
     connection corrections under the substrate lock (exclusive), and the read takes the universe
     lock and then the substrate lock shared. So an item a read could not see is stamped after that
     read ended, and a marker moved from what the read showed can never pass it. No sequence is
     needed.
   - **M7, paging.** `GET /v1/away` returns the newest ten and `nextPage` when there are more;
     `GET /v1/away?page=<cursor>` returns the next older ten. The order is total (the item's
     millisecond, newest first, then kind, then id, compared byte-wise in both SQL and core), so
     pages neither repeat nor skip an item, even inside one millisecond. "Mark as seen" still moves
     the marker to the newest item displayed (ADR-0039 §2); the reader can page through everything
     first, and the section says how many earlier items there are.
   - **M8, Relics.** `GET /v1/relics` pages the same way (newest first by keep time, then id), so
     the oldest Relic can be reached and let go. The Relic card's click names what it opens, and the
     return section's heading is read once.

## Alternatives rejected

- A per-universe away sequence (M6): connection corrections are shared rows changed under the
  substrate lock, not the universe lock; numbering them per universe would need the correction to
  take every affected universe's lock after the substrate lock, the reverse of the order everything
  else uses. The read-side lock gives the same guarantee without a new column.
- "Mark as seen covers only what was displayed" (M7): with a single forward marker and newest-first
  pages it would need a marker per item; paging lets every item be seen with the marker unchanged.
- Copying a Scroll's text into a passage Relic: the claim is an immutable row and the title is
  recorded; the Scroll body belongs to the Scroll and changes with its revisions.

## Not in this version

Rooms and inhabitants, web parity, `relic_moon`, a Relic of a Reel, relics that follow a place into
a new epoch, and away items for corrections of the new kinds (their state already shows it on Keep).

## Consequences

- Migration `0039_typed_relics.sql`: `relic` gains `place_id`, `formation_delta_id`, `asset_id`,
  `asset_revision`, `scroll_title`, `exposure_id`, `ask_id`; `kind` widens; the connection columns
  become per-kind; `cited_claim_keys` is what the Relic rests on (a passage's claim, the answer's
  Scroll claims); one-per-thing indexes; the keep guard covers each kind. `reader_objection` (passage
  and answer objections) with the same history guard. Clear erases Relics before the Ask answers,
  places and exposures they name.
- `packages/core/src/relics.ts` (pure state rule and per-kind facts); `packages/core/src/away.ts`
  (total order and page cursor); contracts `relics.ts`, `away.ts`, `inquiries.ts`;
  `packages/db/src/relics.ts`, `away.ts`, `reasoning-answers.ts`; routes in `return-routes.ts`.
- Android: typed Relic parsing and cards, Keep/doubt on the place sheet, the Scroll reader's
  passages and the Ask answer, paging on Keep and on the return, the M4/M5/M8 fixes.
- Tests: the state rule per kind; keep, idempotence, pause, a real source correction and a real
  revision for each kind, doubt, let go, Clear/Reset/deletion and export; the M4–M8 behaviours,
  including the commit-order interleaving. The coordinator's emulator session keeps each kind,
  doubts one, corrects one through a real correction and lets one go.
