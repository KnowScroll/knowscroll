# Authorized frozen Scroll context

Issue [#60](https://github.com/KnowScroll/knowscroll/issues/60) implements [ADR-0014](../decisions/0014-sealed-direct-context.md). These are internal development operations; the ordinary worker does not compile or dispatch reasoning jobs.

## Calling contract

Inside one caller-owned transaction, use the existing server `authenticateAndLock` and pass its trusted `AuthScope` to `compileDirectContext(client, scope, input, resolvePolicy)`. Do not accept scope from HTTP input or carry it across transactions. The strict input contains a fresh context ID, a queued direct Job ID and 1–16 explicit Keep event IDs. The trusted local/SQL resolver supplies the complete runtime policy. A Keep and intent UUID do not themselves authorize a paid product purpose.

The compiler checks the full Keep/exposure/decision chain and freezes the exact displayed Scroll fields, including body and source attribution. The historical candidate must match the current asset revision and field hash. It rejects rather than truncates bundles exceeding 65,536 canonical UTF-8 bytes. It returns IDs/hashes only. The maximum scoped Ledger sequence is historical metadata; a later unrelated Keep does not stale the bundle.

The first successful compilation binds the Job to the authenticating session. Another session needs a fresh Job and direct intent. Compilation failure rolls back that binding and every context row. The binding, frozen payload and typed dependencies cannot be independently updated or deleted.

## Admission integration

`createDirectContextAuthority(resolvePolicy)` supplies the concrete `ReasoningAuthority` for internal admission and fair scheduling. After creating the Step, its identity must refer to the same Job/context/scope. `validateDirectContext(client, scope, resolvePolicy, phase)` returns a typed valid/refusal result; the authority adapter converts refusals to `ReasoningDenied`.

Callers hold the universe and Job/Step locks. Phase `lock` acquires the original session and sorted selected asset locks before scheduler/resources. Phase `recheck` reads exact dependencies without acquiring new locks after resource waits. Fair preflight carries its locks into reservation in the same transaction. Never use the internal recheck shortcut as an alternative to preflight.

Validation checks canonical bytes and hashes, the complete typed read set, immutable Job/session binding, current epoch, original live session, exact selected lineage, asset fields and the full scope-bound resolved policy. Time is rechecked after waits. It never repairs a stale context or substitutes another session. Global Accounts revisions are not dependencies.

## Privacy and limitations

Migration 0007 adds private canonical payload/dependency storage and the immutable Job/session binding. Context erasure cascades frozen payload/dependencies; Job erasure cascades session binding. Existing authenticated history clear performs both in its transaction while retaining minimal accounting. Session revocation refuses later use but is not immediate data erasure. No retained accounting table references frozen bytes or their hashes.

Source URLs/titles remain editorial pointers, not independently verified or versioned source evidence. This context family supports literal selected Keep facts only. It provides no proposal schema, semantic update, paid task authorization, background intent lifecycle, scheduled retirement, public endpoint or production identity. Provider readiness remains false. See [verification evidence](../journeys/evidence/reasoning-context/README.md).
