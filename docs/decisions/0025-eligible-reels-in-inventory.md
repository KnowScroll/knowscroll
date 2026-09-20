# ADR-0025 — A gated Reel becomes inventory, and the feed stays honest about kinds

Date: 2026-09-20. Status: accepted by the coordinator for the inventory slice under #8/#9/#3/#72.
Builds on [ADR-0024](0024-publication-gates-and-media-serving.md) (gate verdicts and derived
eligibility), [ADR-0023](0023-generated-reel-supply.md) and [ADR-0004](0004-ledger-events-derived.md).

## Context

A gated `generated_reel` is still invisible: exposures, keeps, Traces and the Composer all address
`asset(id)`, and the feed hard-codes `kind='Scroll'`. Reel and Scroll are the product's only two
consumption objects, so a Reel that has passed its gates belongs in the same inventory as a Scroll,
addressed the same way — not in a parallel universe of its own with duplicated history plumbing.

Two constraints shape this. First, existing clients parse feed items strictly; an unknown kind would
break the Android and web readers already in people's hands. Second, migration 0009's Ask lineage
guard requires the exposed candidate to be a Scroll, so a literal Ask about a Reel is refused today.

## Decision

### 1. Publication mints an inventory asset from a gated Reel

When a `generated_reel` reaches `eligible` (or `test_eligible`), publication inserts one `asset` row
of kind `Reel` carrying its media digest, its `generated_reel` id, its truth state and its generated
label. A database trigger refuses a Reel asset whose source Reel is not in one of those states, so
the ADR-0024 stand-in fence carries over unchanged: in the owner's database a stand-in Reel cannot be
eligible, therefore cannot be minted, therefore cannot be selected. Minting is idempotent per
generated Reel, and withdrawing the Reel withdraws its asset.

`asset` is generalised minimally: `editorial_order` becomes nullable (it orders the editorial Scroll
library and means nothing for a generated Reel), and Reel rows carry `media_sha256`,
`generated_reel_id` and a `simulated` flag derived from provenance. A Scroll still requires its body,
source and editorial order; a Reel requires its media and lineage. Every existing Scroll row and
every exposure, keep, Trace and Accounts entry keeps working unchanged, because the identity a person
encounters is still `asset.id`.

A Reel asset's identity and provenance are immutable, since they restate a gated generated Reel. A
**Scroll stays editable in place**: updating a Scroll's content and revision is how this product
represents a corrected or changed source, which Trace revisit, the `source_support` gate and the
sealed Ask and reasoning contexts all depend on. The first draft of migration 0015 froze every asset
row and broke that mechanism in 24 existing tests; the independent review rejected it, and the guard
now applies provenance immutability to Reel rows only. No asset of either kind is ever deleted, and
a kind never changes.

### 2. The feed only offers what the client says it can render

`GET /v1/feed` takes an optional `kinds` parameter, defaulting to `Scroll` alone. A client that can
play a Reel asks for `kinds=Scroll,Reel`. Unknown kinds are refused rather than silently dropped, so
a typo cannot quietly hide Reels. Existing clients keep receiving exactly what they receive today.

A Reel item carries: the same identity, title, summary, truth state and selection reason a Scroll
carries; its media URL (`/v1/media/:sha256`, the only playable address KnowScroll gives out); its
duration and aspect from the stored probe; its generated label; its `simulated` flag when the bytes
came from stand-in providers; and its source lineage for the sources sheet. The engine's own file
path is never sent. Selection stays the bootstrap policy — exclude what is kept, bounded candidates,
recorded reason — with no new inference and no engagement signal.

### 3. Keeps, Traces and Asks

Keeping a Reel records the same Ledger event and the same Trace as keeping a Scroll; no new event
kind is invented. A literal Ask still requires a Scroll candidate (migration 0009's guard), so Ask on
a Reel remains refused; that limitation is recorded here rather than worked around, and belongs to
whichever slice gives Ask an answer.

### 4. What this ADR does not do

No Reel playback UI on either surface, no horizontal branch or continuation, no per-person
repetition policy beyond excluding keeps, no world or bridge behaviour, no correction propagation,
and no change to how media bytes are authorized (still ADR-0024's route).

## Alternatives and why

- *A separate Reel feed and a separate history table:* duplicates exposure, keep, Trace and privacy
  plumbing for the second consumption object, and guarantees the two drift. Rejected.
- *Serve Reels to every client immediately:* breaks the readers that exist. The `kinds` parameter
  costs one line in each client and keeps old builds correct.
- *Give the client the engine path or a filesystem URL:* untrusted host metadata; never.
- *Mint the asset at import instead of at eligibility:* would put ungated media into inventory, which
  is exactly what ADR-0024 exists to prevent.

## Consequences

With no witness, nothing is eligible in a real universe, so a real feed stays Scroll-only and the
owner sees no change. In a disposable test database a stand-in Reel can be minted, offered to a
client that asks for Reels, kept, revisited as a Trace and streamed — which is what lets the playback
UI be built and proved before real generation exists. Journey J007 proves that path; the UI slice
follows.
