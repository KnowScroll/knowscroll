# ADR-0032 — Attention accounts, revisable hypotheses and the semantic Composer (`composer-semantic-v3`)

Date: 2026-09-24. Status: accepted by the coordinator under the owner's six-phase mandate; implemented by
migration 0027 under [#131](https://github.com/KnowScroll/knowscroll/issues/131) (accounts, hypotheses) and
[#133](https://github.com/KnowScroll/knowscroll/issues/133) (Composer), parent #72. Builds on ADR-0028/0029
(recorded-signal ranking and its invariants, which stay in force) and ADR-0031 (substrate, bridges).
Target design input: `docs/architecture/target/06` §3–§10, `08` §1–§9, `16`; product definition §2.2, §5.2,
journeys G and H.

## Context

`composer-signals-v2` ranks by exposure count, recency and source coverage. It cannot continue a thread
the reader started, offer a sourced connection, go deeper, challenge a common misconception or
introduce the outside on purpose, and it cannot say why in terms of the reader's own acts. The
substrate (ADR-0031) now gives encounters concepts and admitted bridges; the Ledger records exposures,
keeps, branches and asks. What is missing is (a) a conservative numeric layer over those acts,
(b) interpretations that stay revisable and correctable without becoming a profile, and (c) a
Composer that uses both, deterministically, with reasons a reader can inspect and correct.

## Decision

### 1. Attention accounts (`attention-v1`), a projection, not a profile
Per (universe, concept): episodes, voluntary marks, returns, active days, span, evidence families,
system-offered share, negatives, and a mass that decays with a 21-day half-life. An **episode** is one
exposure plus the voluntary acts it caused (keep, branch, ask); its weight is 0.5 for being shown,
+1.5 per distinct voluntary kind (max 3), +2.0 for a separated return (≥ 4 h after the previous
episode on that concept, with a voluntary act). Credit follows the encounter's annotated concepts
(primary 1.0, secondary 0.5, mentioned 0.2). Watching alone contributes 0.5, however long.
State lines (`seen`, `anchored`, `dormant`) are bench thresholds recorded with the policy version,
routing hints for the Composer and Cartographer — never a label about the person. The projection is
recomputed from the Ledger in the transaction that records new evidence; transitions are logged.

### 2. Hypotheses (`hypothesis-rules-v1`): typed, evidence-linked, competing, decaying
Rules propose from accounts; later a model may propose through the same validator (#132).
- Kinds this version writes: `direction` ("recent voluntary acts cluster around X") and
  `open_question` (an Ask recorded on an encounter about X, not yet resolved). Prohibited kinds —
  identity, diagnosis, mastery, belief, character — are never written; the validator refuses them.
- Every hypothesis cites evidence (exposure, mark and feedback ids), states at least one competing
  alternative with its own evidence (e.g. "the feed offered X often" when most episodes were
  system-offered), lists counterevidence (a reader's "less like this" or hidden connection), carries a
  confidence *label* (never shown as a number), a decay policy, and **permitted uses**. Only a
  rule-proposed `direction` may carry `composer.family_prior`.
- A reader never edits a profile (journey G). Their correction is counterevidence: it contests the
  hypothesis, suspends its permitted use, and suppresses the causal route.

### 3. The Composer (`composer-semantic-v3`), deterministic, no model call
Families: `continue` (a thread the reader acted on), `deepen` (narrower concepts of what they
marked), `bridge` (admitted, non-suppressed bridges from what they marked), `challenge` (sources that
contradict a common idea near what they marked), `revisit` (a seen encounter newly relevant because
of a later act), `frontier` (a domain this universe has never been shown), `seed` (cold start: one
door per domain) and `fallback` (unmapped inventory, so nothing in the library is hidden).
Gates are hard and recorded with reasons (kept, the encounter on screen, suppressed by the reader).
A *seen* encounter is not gated: exposure-aware reranking keeps it available below unseen ones,
least-seen first, through a recorded `seen` term, so the library is exhausted only when everything
is kept, exactly as before v3. (An earlier draft gated seen encounters; the web reader journey
showed that this silently changed the established exhaustion contract, and the handoff asks for
reranking, not removal.) Terms are a transparent versioned utility (continuity, a
target-conditioned useful-encounter proxy that saturates when a concept was mostly system-offered,
depth, novelty, return relevance, a permitted direction prior, minus redundancy of arguments
already served by *other* encounters, fatigue and seen). Watch time is not an input.
Selection enforces, over the **rolling sequence actually served** (each decision serves one
encounter on the current clients): an exploration floor (one of `bridge/frontier/challenge/revisit/
fallback` at least every third served encounter when eligible), no adjacent repeat of a concept
unless the reader acted on it, and per-source/per-concept diversity in the slate.

### 4. Recorded, replayable, explainable
Every candidate the policy considered — selected or excluded — is a `decision_candidate` row with its
family, gate outcome, terms, score, rank and the facts its explanation may cite; the served window and
bound quotas are recorded on the decision. Explanations are rendered only from registered
`composer_reason_template` rows whose placeholders are whitelisted recorded facts; the evidence path
("you kept …", "you followed …") is built from recorded ids, never prose authored per item. Replaying
the recorded state through the same policy reproduces the slate (tested). ADR-0029's commit-time
invariants are kept for v3 by equivalent triggers on `decision_candidate`; `composer-signals-v2` stays
registered and immutable.

### 5. Correction (journey G)
`GET /v1/decisions/:id/why?assetId=` returns the recorded reason, family and evidence path.
`POST /v1/encounters/feedback` records `less_like_this` (suppress the family+concept route for this
universe for a policy-defined period and add counterevidence) or `wrong_connection` (for bridge
candidates: the ADR-0031 personal suppression). Neither retracts shared knowledge; both are private
history erased by Clear/Reset and exported.

## Alternatives rejected
- Thompson sampling over families now: there are not yet enough recorded outcomes to calibrate it;
  the deterministic exploration floor is the honest first policy, and the recorded terms make a later
  bandit evaluable off-policy.
- Showing hypotheses in a "what we think about you" screen: the product forbids a profile editor.
- Letting a model rank: ADR-0016/0029 stand; models only propose.

## Consequences
Migration 0027, contracts `packages/contracts/src/composer.ts`, pure modules
`packages/core/src/semantic/attention.ts`, `hypotheses.ts`, `packages/core/src/composer/semantic.ts`,
database modules under `packages/db/src/semantic/` and `packages/db/src/composer/`, API routes in
`apps/api/src/composer-routes.ts`, Android why-sheet evidence and corrections. All thresholds are bench
values recorded with their policy version. Usefulness is evaluated separately from correctness
(offline replay comparison plus owner review), never inferred from engagement.
