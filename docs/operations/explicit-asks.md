# Explicit Ask source facts

[Issue #64](https://github.com/KnowScroll/knowscroll/issues/64) and [ADR-0016](../decisions/0016-explicit-ask-facts.md) implement an authenticated private input boundary. `POST /v1/asks` stores the person's exact decoded question about an exposed Scroll and returns `recorded_only`. There is no answer, pending job, semantic interpretation or mobile control.

## Input and transaction

Use the [HTTP contract](../contracts/bootstrap-http.md). A question must contain non-whitespace content, valid Unicode scalars, no NUL, and at most 4096 UTF-8 bytes. A 32 KiB route envelope supports escaped JSON. Identifiers canonicalize to lowercase; question text preserves whitespace, normalization and line endings exactly. Equivalent JSON escape spellings decode to the same literal input.

`recordExplicitAsk(client,scope,input)` requires the same client/transaction on which `authenticateAndLock` resolved scope, holding universe then session locks. It checks expected epoch before replay. Same original session plus client Ask ID replays only identical question/exposure/epoch; another session using the same client UUID creates its own fact. The Ledger key is a domain-separated deterministic UUID of those identifiers. No caller-provided asset, decision, universe or session authority is accepted.

New admission verifies exposure→exposure-event→decision lineage and complete selected/current Scroll content. It locks the shared asset, then rechecks session and source after waiting. Source drift refuses admission; use a fresh encounter. The immutable Ledger event and `explicit_ask` binding commit together; deferred SQL constraints reject half-facts, foreign scope and forged source relationships. Only the Ledger payload stores the question. Existing event lookup returns metadata, not question payload. Replay acknowledges a recorded fact, so later asset edits do not change its receipt.

There is no Accounts/Trace/fairness/accounting or Job mutation. A stored Ask cannot be passed as Keep evidence to `direct_scroll_evidence_v1`. Future Ask context requires its own typed contract and fresh original-session authorization; this source row is not perpetual dispatch authority.

## Privacy

Source history remains until Clear History, like exposure and Keep. The seven-day withdrawn execution-context policy does not apply to Ask facts. Clear advances the epoch and removes the source/event binding atomically through existing cascades; SQL refuses Ask Ledger deletion without an advanced epoch. Exact old clear receipts preserve later actions. An old-epoch Ask retry conflicts before replay/recreation. Other universes survive, and failed transactions roll back. Production account deletion and backups remain separate scope.

## Verification and limits

`pnpm exec tsx scripts/run-isolated-ask-journey.ts artifacts/explicit-ask-journey.json` creates a disposable PostgreSQL database and a separate HTTP API process. It records/replays a synthetic literal Ask, verifies conflicting reuse and no execution/projection state, restarts that API and replays the same durable receipt, clears history, rejects old-epoch retry, preserves a later Ask under an old clear replay, then removes its process/database.

This proves HTTP/storage behavior with fixtures, not PostgreSQL restart, mobile Ask UX, an answer, provider execution, semantic application or usefulness. [Evidence](../journeys/evidence/explicit-asks/README.md) pins tested revisions. The owner's existing API process is not implicitly restarted by pulling code; this internal endpoint requires an API launch on the new revision when needed. Product reasoning remains disabled.

## Answers (ADR-0033, #132)

A recorded Ask stays a fact. An answer exists only after a separate, fresh request from the Ask's own
session (`POST /v1/asks/:askId/answer`); the worker sends the sealed question and Scroll to the enabled
route once and applies the reply only through the answer validator. Clear and Reset erase answer
requests and answers with the Ask; minimal content-free accounting keeps its ADR-0019 retention. See
the [evidence](../journeys/evidence/ask-answers-2026-09-24/README.md).
