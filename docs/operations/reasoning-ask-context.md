# Authorized literal Ask context

Issue [#66](https://github.com/KnowScroll/knowscroll/issues/66) implements [ADR-0017](../decisions/0017-sealed-ask-context.md). This is an internal context boundary. Ask HTTP recording still returns `recorded_only`; ordinary reasoning and mobile Ask remain disabled.

## Calling contract

Authenticate and compile on the same client in one caller-owned transaction. `compileDirectAskContext(client, authenticatedScope, {contextId,jobId,askId}, resolvePolicy)` consumes an existing, separately authorized queued direct Job. Its `intent_id` must equal the Ask ID. Universe, current epoch and authenticated session must match the original Ask; another valid session cannot substitute. The trusted local policy resolver must match subsequent validation. No HTTP input may supply authority.

Compilation freezes the exact decoded question without trimming or Unicode normalization, the unique displayed Scroll candidate and complete current asset, Ask/event/exposure/decision lineage, original session expiry and complete scope-bound policy. Eight exact typed dependencies bind those facts. Ambiguous candidates, changed content even at the same revision, mismatched intent, stale sessions and malformed/extra/missing dependencies fail closed. The informational Ledger watermark does not invalidate a bundle when unrelated events arrive. Canonical UTF-8 payloads exceeding 65,536 bytes are rejected without truncation.

The compiler creates only immutable context/session/Ask bindings, metadata, typed dependencies and a seal. It returns IDs and hashes, not question content. It creates no Job, Step, queue membership, Attempt, Permit, accounting, provider request or projection. All writes roll back on failure. A recorded Ask is not permission to start a paid task.

## Family routing and locks

`createSealedContextAuthority(resolvePolicy)` explicitly routes immutable `source_policy_version` metadata: `editorial-asset-pointer-v1` to the unchanged Keep validator, `ask-editorial-asset-pointer-v1` to the Ask validator. Unknown families fail. Each validator checks the actual payload and seal independently. The original `createDirectContextAuthority` remains Keep-only.

Compilation takes universe → original session → Job → sorted shared asset locks. Internal fair admission, standalone reserve and dispatch acquire the bound session before their first Job lock. `lockBoundContextSession` is a lock-order helper; it neither authenticates nor accepts a missing binding. Ask validation's `lock` phase acquires the selected asset locks before shared scheduler/budget resources. Its `recheck` phase performs only reads after resource waits. Direct callers must hold universe, original session and Job locks in that order. The same-transaction fair reserve shortcut may use recheck only after preflight has retained all dependency locks.

Current session expiry/revocation, Job deadline, source and policy are checked again after waits. Validation never rewrites dependencies, substitutes a session or repairs a stale context. Context freshness alone is not a transport grant or proposal/application acceptance.

## Storage, privacy and limits

Migration `0010_ask_context_binding.sql` adds the scoped immutable Job↔Ask binding and guards family consistency and bound Job identity. It reuses existing sealed context storage and leaves migrations 0001–0009 unchanged. The first-family guard serializes on the Job even for trusted raw SQL inserts.

Clear History removes private execution graphs and bindings before erasing source Ask history. Seven-day retirement removes safely withdrawn cancelled/expired Job/context graphs while retaining the Ask source fact. An exact Ask replay after retirement returns its original source-only receipt; it does not recreate private execution state or authorize a replacement Job. Unknown retained liabilities keep the existing accounting policy.

This slice provides no answer, generated Reel, semantic inference, paid-task admission policy, background coalescing or production identity. Full v1 remains governed by [the release contract](../product/v1-release.md), including both UI surfaces and real Cutroom integration. Current owner-process schema deployment is an operational observation, separate from source availability.

Verification receipts and exact tested revisions belong in [Ask context evidence](../journeys/evidence/reasoning-ask-context/README.md).
