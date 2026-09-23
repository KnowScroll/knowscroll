# ADR-0031 — Semantic substrate: source-backed claims, and bridges only a validator can admit

Date: 2026-09-24. Status: accepted by the coordinator under the owner's September 24 six-phase
mandate; implemented by migration 0026 under [#131](https://github.com/KnowScroll/knowscroll/issues/131)
(parent #72). Builds on ADR-0004 (canonical history), ADR-0010/0030 (erasure and export) and
ADR-0028 (evidence-backed worlds). Target design input: `docs/architecture/target/05` §4,
`06` §10, `07` §2 and `08` §3–4.

## Context

A world that only groups assets by source URL (ADR-0028) cannot say why one encounter connects
to another. The target design requires a substrate of concepts, claims and sources, and
conceptual bridges that change the experience only when they carry a typed mechanism, both-sided
evidence and stated limits. The dangerous shortcut is a bridge created from shared keywords,
co-exposure or a model's confidence: it would look like understanding and prove nothing.

## Decision

1. **Knowledge is source-backed and immutable.** A `claim` is supported only by an exact quote on a
   *current* `source_snapshot` (whose visible text was hashed when the quote was verified). A
   changed statement is a new claim; a changed source is a correction plus a new snapshot
   revision. `claim_is_supported()` is the single SQL definition of support.
2. **Every connection is a proposal, decided deterministically.** Editorial curation, rules, model
   output (#132) and people submit the same `bridgeProposalPayload`. The pure validator
   (`packages/core/src/semantic/bridge-validator.ts`, `bridge-validator-v1`) admits a bridge only
   if: the sides exist and are not parent/child; every cited claim is currently supported; each
   side has its own evidence; the mechanism is evidenced by one claim connecting both sides (or,
   for symmetric comparisons, one claim per side naming the same mechanism concept); directional
   types carry their direction in that evidence; analogies state an `analogy_limit`; and known
   counterevidence is listed, with a directional bridge the substrate contradicts refused.
   Shared vocabulary is reported as a diagnostic and never counts.
3. **Decisions are replayable.** Each `semantic_proposal` stores its payload, the exact read-set
   slice the validator consulted, and the decision. Re-running the validator on the slice
   reproduces the decision (tested).
4. **The database refuses the unsafe states.** An admitted `bridge` needs an admitted proposal of
   the same scope and, at commit, currently supported `from`, `to` and `mechanism` evidence.
   Bridge content, claims and concepts cannot be edited; shared bridges are revoked, never deleted.
5. **Corrections propagate by revalidation.** Correcting or revoking a snapshot marks affected
   claims unsupported, revokes relations they backed, and re-runs the validator on every admitted
   bridge citing them; failures are revoked with reasons. Every change is a recorded
   `semantic_correction_effect`. Nothing is silently restored.
6. **Personal consumers are private history.** Branch opens (a `branch` Ledger event caused by the
   exposure it started from, plus a `decision` serving the target) and connection feedback are
   universe-scoped, erased by Clear/Reset before the rows they reference, and exported. While
   recording is paused a branch is served but nothing personal is kept. A person's "seems wrong"
   suppresses the connection for that universe and never retracts shared knowledge.
7. **Locks.** Universe row lock first, substrate advisory lock second (exclusive for shared
   writes and corrections, shared for private writes and erasure). Corrections never take a
   universe lock, so the orders cannot cycle.

## Alternatives rejected

- *Keyword/embedding similarity as a bridge:* the exact "tempting but unsupported" failure.
  Embeddings may later propose sightings; they never admit bridges.
- *A confidence threshold on model output:* confidence is not calibrated correctness (target 08 §11).
- *Editing claims in place:* rewrites what a reader was already shown and breaks replay.

## Consequences

- New migration 0026 (appended to `RELEASED.txt`), contract `packages/contracts/src/semantic.ts`
  (`semantic-v1`), HTTP `GET /v1/assets/:assetId/branches`, `POST /v1/branches`,
  `POST /v1/connections/feedback`, operator CLI `scripts/substrate/correct-source.ts`, editorial
  seed `content/substrate.json` loaded by `pnpm db:seed` with quotes verified by
  `scripts/substrate/verify-substrate.ts`.
- Not yet implemented here: attention accounts, hypotheses and their decay, foundation Stars and
  recursive geography (they consume this contract in later #131/#134 slices), model-proposed
  bridges (#132), Composer use of bridges (#133). The editorial substrate is small; its size, not
  the design, bounds how many connections exist.

## Verification

Pure adversarial tests (`tests/semantic-bridge-validator.test.ts`, with mutation checks), real
PostgreSQL/HTTP tests (`tests/semantic-substrate.test.ts`), populated upgrade
(`tests/semantic-migration.test.ts`), and the evidence recorded on #131.
