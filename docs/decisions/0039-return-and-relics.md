# ADR-0039 — The return: what changed while you were away, and connection Relics

Date: 2026-09-24. Status: accepted by the coordinator for [#134](https://github.com/KnowScroll/knowscroll/issues/134)
(living world), parent #72. Builds on ADR-0010/0030 (Clear, pause, Reset, export), ADR-0031
(bridges only the validator admits), ADR-0035 (account deletion), ADR-0036 (the reader's places and
their deltas), ADR-0037 (foundation Stars) and ADR-0038 (background bridge inquiries).
Target design: `docs/product/definition.md` Journey E and "Relic is not Scroll",
`docs/architecture/target/07-UNIVERSE-EVOLUTION.md` §5, `10-CORE-AGENT.md` (the night pass).

## Context

KnowScroll now does real work while the reader is away. With consent, a background inquiry
(ADR-0038) looks for a sourced connection between two of their places, and the validator decides.
A source correction can also revoke a bridge, which withdraws a foundation Star (ADR-0037). None of
this reaches the reader on return. Background inquiries are listed only deep in Privacy & account.
Recent changes on the atlas mix the reader's own reading with changes they never saw happen.

The product also promises Relics: durable things a person deliberately keeps, which retain
provenance, truth state and correction dependencies, and "show that a claim was corrected or
superseded". No Relic exists. Keep holds only Traces, which are keyed by asset.

## Decision

1. **"While you were away" lists only what the reader did not cause.** `GET /v1/away` returns, newest
   first, the changes in this universe and epoch since the reader last acknowledged a return:
   - inquiry outcomes: `found` (with the bridge's sentence and evidence), `nothing_found` and
     `did_not_hold_up` (with the validator's reasons);
   - atlas deltas whose causal class is `source_correction`. Every other cause
     (`personal_exploration`, `substrate_neighbourhood`, `reader_correction`) comes from the
     Cartographer's refresh after the reader's own action, so the reader saw it happen;
   - status changes of bridges the reader was shown as found or kept as a Relic (`revoked`,
     `superseded`), with the correction's reason.
   Each item is typed and carries its evidence reference. The list is capped (at most 10 items, with
   a count of the rest). No item is composed by a model: a delta carries the chronicle's own
   deterministic line (ADR-0036), and the client words the rest from their types.
2. **The return marker is the reader's to move.** `POST /v1/away/acknowledge` with a client request
   id, the expected epoch and `through`: the time of the newest item the client displayed, so an item
   that arrives while the section is on screen is not swallowed. Markers only move forward. They are
   personal history: erased by Clear/Reset/deletion, exported. While recording is paused the marker
   does not move (the request is refused), because it records when the reader looked.
3. **A Relic is a typed, private, immutable keepsake with provenance.** First kind: `connection`. A
   connection Relic points to one bridge the reader can see (shared, or their own), and was admitted
   when kept. It records at keep time: the bridge id, relation, the validator version, the cited
   claim keys, and, when it came from an inquiry, the inquiry and attempt ids. `POST /v1/relics`
   (client request id, expected epoch, kind, bridge id) is idempotent. It is refused while paused
   (like a keep, ADR-0030), for a bridge that is not admitted, and for a bridge this reader has marked
   "seems wrong". One Relic per bridge per epoch.
4. **A Relic never hides a correction.** `GET /v1/relics` derives each Relic's state when read:
   `current`; `corrected` (the bridge was revoked or superseded, with the reason); or `doubted` (the
   reader marked the bridge "seems wrong" after keeping it). The kept form stays readable. The Relic
   is not deleted by a correction. `POST /v1/relics/:id/release` lets the reader let it go: the row is
   removed, not hidden.
5. **Reject or correct uses what exists.** "Seems wrong" on a found connection is
   `POST /v1/connections/feedback` (ADR-0031): personal suppression, never a retraction of shared
   knowledge. A place that should not exist is set aside with the existing reject (ADR-0036).
6. **Android shows it where the reader returns.** A quiet "While you were away" section at the top of
   the atlas, only when there is something unacknowledged. Each item opens its evidence, and a found
   connection offers "Seems wrong" and "Keep". Keep lists Relics above Traces, each with its state.
   The web client is not in this slice.

## Not in this version

Rooms and inhabitants (every resident step is a model call at room cost; a later slice can open a
personal room from a kept question). A nightly deterministic pass. Relic kinds other than
`connection`. `relic_moon`. Web parity.

## Consequences

Migration 0033 (`away_acknowledgement`, `relic`, guards: immutable rows, epoch match, no keep while
paused, a bridge a Relic points to cannot be erased before the Relic); `packages/core/src/away.ts`
(pure: item selection and ordering); `packages/db/src/away.ts`, `packages/db/src/relics.ts`;
contracts `away.ts`, `relics.ts`; routes; Clear/Reset/deletion erase and export; Android data and
UI; an emulator journey that returns after real background work (fixture, then one bounded live
request), inspects the evidence, marks one connection "seems wrong", keeps another as a Relic, then
sees a source correction mark the Relic `corrected`.
