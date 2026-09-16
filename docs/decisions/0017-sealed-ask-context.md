# ADR-0017 — Sealed literal Ask context

Date: 2026-09-16. Status: coordinator contract for #66; independent acceptance pending. Extends ADR-0014/0016, with ADR-0015 retirement unchanged.

## Decision

Add the separate `direct_ask_evidence_v1` family. `direct_scroll_evidence_v1` remains Keep-only with unchanged bytes and parsing. A trusted caller, on the same authentication transaction, supplies `{contextId,jobId,askId}` to `compileDirectAskContext`. The caller must separately authorize and create a queued direct Job; compilation creates only its immutable binding, context metadata, eight typed dependencies and seal. It creates no Job, Step, ready membership, Attempt, Permit, accounting, provider call, answer or mobile control.

Require Job.intent_id = explicit_ask.id, current universe/epoch, and the authenticated session to equal the Ask's original live session. A recorded fact and bare intent UUID are not paid-task permission. There is no execution consumer in this slice.

## Representation and storage

`packages/contracts/src/reasoning-ask-context.ts` defines exact unnormalized literal question, Ask/event/client/Job identities, original session and expiry, scoped policy fingerprint, exposure event/row, uniquely selected decision candidate, complete current Scroll and eight typed reads: Ask Ledger, explicit Ask/Job binding, exposure Ledger, exposure row, decision candidate, asset, session and runtime policy. Each hash covers all selected identity/content fields; no inferred meaning or truncation. Use sorted-key canonical JSON, exact strings and decimal sequence counters. Canonical payload is bounded at 65,536 UTF-8 bytes. Reject duplicate, missing, extra, foreign or changed reads.

Migration 0010 adds `reasoning_context_job_ask(job_id,universe_id,privacy_epoch,session_id,ask_id)`. Composite references bind the existing immutable Job/session row and original Ask. Insert session binding, Ask binding, context, dependencies, then seal in one caller-owned transaction. Failed compilation rolls all back. Immutable triggers reject rebinding, bound Job identity mutation, cross-family contexts and standalone binding deletion. Existing 0001–0009 remain immutable. Existing seal/dependency storage is reused without reinterpreting old payloads.

Family dispatch uses immutable context metadata `source_policy_version`: Keep `editorial-asset-pointer-v1`; Ask `ask-editorial-asset-pointer-v1`. `createSealedContextAuthority` routes only these two explicit families and refuses unknown metadata; each validator independently checks kind, version, complete bytes and binding. The original Keep-only factory stays Keep-only.

## Locks and freshness

Compile locks universe → original session → Job → sorted shared assets. Reread current epoch/session/Job/deadline/source after waits; policy resolution is trusted local SQL with no network or new dependency locks. Rechecks after asset acquisition are plain reads. Source changes must not introduce a new unlocked asset.

Admission's universe-held pre-Job phase locks the existing immutable bound session before the Job/Step, including fair preflight, standalone reserve and dispatch. The fair scheduler does this before its own first Job lock. Bound-session lookup is scoped; absent binding is left for the selected validator to reject. The same-transaction fair reserve recheck skips this acquisition because preflight already holds it. Ask validator `lock` then acquires only sorted asset locks; `recheck` takes no new locks. Direct validator callers must hold universe, original session and Job locks in this order. Session expiry and Job deadline are checked again after waits. No context validation itself grants execution authority.

## Privacy and alternatives

Clear removes execution graphs before Ask history, so the binding FK prevents orphan source erasure. Seven-day retirement cascades the binding from Job deletion while retaining the Ask fact. Exact Ask replay remains `recorded_only` and creates no replacement execution state. A new Job needs separate fresh authorization even after retirement; no replay consumer exists here. Unknown accounting liabilities retain their existing policy.

Overloading Keep V1 would change historical meaning; accepting a caller's current session would lose original intent provenance; treating Ask recording as Job admission would grant unrequested execution. Separate family and scoped binding make those distinctions executable. This decision enables no ordinary reasoning or semantic application.

## Verification

Require disposable PostgreSQL proof for literal/Unicode preservation, authority/scope substitution, expiry/revocation, old epoch, lineage ambiguity/drift, binding/seal/read tampering, ordered lock waits, rollback, Clear and retirement replay. Exercise routed authority through internal fair reserve/dispatch with synthetic fixtures, preserve Keep regression evidence, and obtain independent privacy/concurrency review. Product/UI, live provider and full v1 acceptance remain separate gates.
