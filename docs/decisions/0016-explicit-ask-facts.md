# ADR-0016 — Literal exposure-anchored Ask facts

Date: 2026-09-16. Status: accepted and independently reviewed for #64. Uses accepted target direction in ADR-0008. No provider enablement.

## Context

The accepted target distinguishes literal person-written intent from model-proposed hypotheses. The existing product records exposure and Keep but has no durable literal Ask source. A paid execution consumer is not yet enabled.

## Decision

`POST /v1/asks` records a person's literal question about an already exposed Scroll. Strict input is `{clientAskId, exposureId, expectedPrivacyEpoch, question}`. UUIDs are canonicalized to lowercase for identity; question text is never trimmed, normalized, rewritten or model-authored. Reject blank text, malformed Unicode, NUL and more than 4096 UTF-8 bytes. Literal preservation refers to the decoded Unicode string; equivalent JSON escape spellings are the same input. The route accepts a bounded 32768-byte JSON envelope so a valid 4096-byte question can use escaped JSON. Authentication precedes body handling and takes the universe lock, then rechecks session authority and current epoch as in ADR-0009.

Require `expectedPrivacyEpoch` to equal the authenticated current epoch before replay or writing. Resolve the exposure, its exposure Ledger event and decision in this universe/current epoch (existing exposures have no session provenance, so no same-session exposure claim); verify the actual selected Scroll candidate and asset lineage. On new admission the full selected snapshot must still match the current asset; acquire its share lock and recheck source plus live session after waiting. A changed asset requires a new encounter. Exact receipt replay returns the already recorded fact without turning current asset drift into new admission. A client cannot provide universe, session, asset or decision authority. An immutable `ask` Ledger event retains the literal question and server-derived lineage. An `explicit_ask` row binds its event, original session, client Ask ID, exposure, universe and epoch. Both commit in the same transaction. The schema prevents foreign lineage, changed Ask facts and orphaned Ask/event pairs. No projection or reasoning Job is created.

Idempotency is `(universe, original session, clientAskId)` within retained history. Identical input returns the same `{askId,eventId,status:'recorded_only'}` with HTTP 201; a different exposure or literal question conflicts with 409. The Ledger UUID key is a domain-separated deterministic hash of session ID and client Ask ID; existing universe/kind/key uniqueness is preserved. A different authenticated session using the same client UUID records its own action, never claims the original session's intent. The original session is provenance only; a future consumer must recheck live authority before using it.

The receipt says only that the action was stored. It promises no answer, queue, completion, ETA or paid task. No mobile Ask control is enabled while it cannot answer. Existing event lookup can expose event metadata in the same universe, but does not expose question payload. No new consumption object, semantic question node, belief, inferred learning, hypothesis or recommendation is created.

## Privacy and future context

Ask is private source history, like exposure and Keep Ledger records, retained until Clear Scroll History. It is not withdrawn execution context; ADR-0015's seven-day cleanup does not erase its source fact. Clear deletes the Ask and binding in its existing universe-first transaction. Ask Ledger deletion requires the universe epoch to have advanced beyond that fact; paired deletions cannot bypass this condition. Foreign universes survive. An old clear receipt remains a no-op; old-epoch Ask retries fail before replay and cannot restore cleared data. Failed admission or clear rolls back atomically. Account deletion and backup retention remain separate unresolved scope.

`direct_scroll_evidence_v1` remains Keep-only. An Ask event cannot be substituted for Keep evidence or silently enqueue reasoning. A later Ask context version must include exact literal intent, original-session authority, exposure/event/decision/asset snapshots and typed freshness dependencies. That work and proposal/application operations remain separate gates before provider dispatch.

## Verification

Real PostgreSQL and authenticated HTTP must exercise strict UTF-8 bounds, literal preservation, source/foreign/epoch rejection, duplicate races and conflicts, immutable lineage, forced rollback, clear/retry races and authority expiry after lock waits. Assert no Job, accounting, Accounts or Trace mutation and that Keep-context V1 rejects Ask. A separate-process disposable HTTP receipt establishes request/storage/clear behavior, not an answer, provider behavior or useful learning. Released migrations and owner history remain unchanged.

## Alternatives and consequences

Inferring Ask from Keep would invent intent. Returning pending without a Job would falsely promise execution. This slice records only the source fact and keeps mobile Ask unavailable until an answer consumer exists. Putting literal text in both Ledger and a mutable intent record would create two competing authorities; the binding stores identifiers only. The new input increases private source history retained until clear, so epoch-fenced retries and clear-only erasure ship in the same migration/API change.

Sources: [accepted foundation](ADR-0008-foundation-adoption.md), [literal intent target](../architecture/target/06-USER-WORLD-MODEL.md), [HTTP contract](../contracts/bootstrap-http.md), and [source-stamped verification](../journeys/evidence/explicit-asks/README.md).
