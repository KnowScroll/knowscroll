# ADR-0024 — Publication gates, eligibility and media serving

Date: 2026-09-20. Status: accepted by the coordinator for the publication slice under #9/#12/#72.
Builds on [ADR-0023](0023-generated-reel-supply.md) (imported media that is deliberately never
eligible), [ADR-0009](0009-device-sessions-and-privacy-epochs.md) and the product definition's
§5.8 reconciliation, §12 truth states and [quality gates](../architecture/target/14-QUALITY-ANTI-SLOP.md) §3.

## Context

#94 ends with a verified MP4 in KnowScroll storage and an immutable `generated_reel` whose
availability can only be `imported`. Nothing may be served until KnowScroll's own gates have
spoken, because the engine's opinion of its output is not KnowScroll's evidence.

The product's gate set requires a **Visual Witness**: an independent observation of what the frames
actually show, reconciled against the claims and truth state. That needs a vision model, and product
reasoning dispatch is disabled, with no paid provider authorized. Therefore **no generated Reel can
become eligible in a real universe under this ADR** — and that must be a structural fact, not a
promise in prose.

## Decision

### 1. Gates are recorded verdicts, and eligibility is derived

`publication_gate_result` stores one immutable row per (generated Reel, gate, policy version):
verdict `pass`, `pass_with_label`, `fail` or `unavailable`, plus evidence and a decision time.
Availability is never set by hand; it is computed from the current policy's required gates. A
`fail` or `unavailable` on any required gate means not eligible, and `pass_with_label` records that
the encounter must carry its label wherever it is shown.

### 2. The gates in this slice

Deterministic, model-free, and computed from data KnowScroll already holds:

- **lineage_complete** — brief digest matches the stored brief, the attempt's contract revision and
  run id match, every claim has a source, and the record summary exists.
- **source_support** — every narration sentence references at least one claim; every claim's source
  asset revision still exists and is unchanged. A changed source fails closed, as saved-Trace
  revisit already does; correction propagation is a later slice, not a silent pass.
- **engine_record** — from Cutroom's own record: no `used` take carries a `fail` check. Any
  degradation yields `pass_with_label`, never a silent `pass`.
- **media_conformance** — the stored file still exists at its content-addressed key, its bytes still
  hash to `sha256`, and its probe still matches the required profile.
- **truth_label** — truth state `synthesis` with the generated label set.
- **repetition** — template and argument fingerprints computed from the brief's structure, compared
  against the eligible corpus; an empty corpus passes trivially and the fingerprints are stored so a
  second, near-identical Reel does not.
- **witness_alignment** — **required and structurally unavailable.** No vision model exists to make
  this observation, so the gate records `unavailable` with that reason and blocks eligibility. It is
  not stubbed as passing, and no default makes it optional.

### 3. The stand-in fence is enforced by the database, not by discipline

A generated Reel from a `standin` engine may reach `test_eligible` **only** inside a disposable test
database, enforced by a trigger checking `current_database()` against the `knowscroll_test_%`
pattern. In the owner's database that value cannot be written at all. `eligible` additionally
requires every required gate to pass, which the witness gate currently prevents. So journeys can
prove serving, feed inclusion and playback end to end with stand-in media, while the owner's
universe cannot receive it even by mistake.

### 4. Media serving

`GET /v1/media/:sha256` (and `HEAD`) serves KnowScroll-owned bytes only:

- The path parameter must match `^[0-9a-f]{64}$`; the file is located by the stored `storage_key`,
  never by any caller-supplied path, and never by an engine path.
- Authorization happens in one short transaction (device session, epoch, and an eligible or
  `test_eligible` generated Reel referencing that media); **bytes are streamed outside any
  transaction**, because a database transaction must never be held across a slow client read.
- Range requests are supported (`206` with `Content-Range`, `416` for an unsatisfiable range);
  responses carry `video/mp4`, `Accept-Ranges`, `Content-Length` and immutable, private caching.
- An unknown, ineligible or missing-file asset is `404` with the standard error shape. A
  `test_eligible` asset is served with an explicit simulated marker so no client can mistake it.

### 5. What this ADR does not do

No feed change, no Reel in any surface, no EncounterBinding, no per-person selection or repetition
policy, no correction propagation, no retention or deletion policy for media, and no witness.

## Alternatives and why

- *Stub the witness as passing until a model exists:* it would make "eligible" mean nothing, and the
  first real Reel would inherit a false gate. Rejected.
- *Allow an operator override for eligibility:* the same hole with a human name on it. The only
  override is `test_eligible`, which the database refuses outside a disposable test database.
- *Serve from the engine's artifact path:* untrusted host metadata with no retention promise
  (ADR-0007/0023). Rejected.
- *Sign URLs instead of authenticating:* a bearer-authenticated range endpoint reuses the existing
  session model; signed URLs are a later deployment concern, and `<video>` on web will need one.

## Consequences

A real generated Reel in a real universe now needs exactly three things, all named: upstream Cutroom
real providers, a Visual Witness implementation with its own authorized model dispatch, and this
gate set at a policy version. Journeys can prove the serving path now with stand-in media. Web
playback through a plain `<video>` element cannot send an Authorization header, so the desktop
surface will need either the dev proxy or a later signed-URL contract; that is recorded here and
decided when playback lands.
