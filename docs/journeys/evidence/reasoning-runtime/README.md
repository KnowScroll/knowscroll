# Atomic reasoning primitives — issue #45

Date: September 16, 2026. Parent [#7](https://github.com/KnowScroll/knowscroll/issues/7); design [#42](https://github.com/KnowScroll/knowscroll/issues/42); storage [#44](https://github.com/KnowScroll/knowscroll/issues/44); implementation [#45](https://github.com/KnowScroll/knowscroll/issues/45).

## Scope and ownership

Migration 0005 adds immutable policy/input bindings and cumulative reservation metadata. New internal factories implement claim/reserve/dispatch authorization, withdrawal/recovery and receipt reconciliation. An unwired worker boundary checks serialized bytes, invokes an injected transport once and retains only minimal accounting observations.

Sol implemented admission, lease and recovery in the reasoning worktree (focused PR #50). Terra implemented reconciliation in the core worktree (focused PR #49). A separate Terra reviewer inspected the shared contract and both implementations. The coordinator owned migration/policy validation, the worker boundary, combined SQL/HTTP proof, documentation and integration. Each lane used isolated disposable PostgreSQL data. The integration PR releases the reviewed pieces together.

## Review corrections

Actual diff review and tests corrected canonical multi-Attempt bucket locking, input-ceiling binding, deadline/context checks after lock waits, stale-lease accounting withdrawal without private checkpoint changes, cancellation after an unknown outcome and recovery of later Attempts under an already-fenced Job.

Accounting review corrected rate charges below the reservation floor, partial nullable usage across multiple receipts, PostgreSQL bigint string comparisons, frozen receipt replay and settlement of previously appended internal evidence. A flaky concurrency test was corrected to observe the database lock wait rather than infer it from a timer or a callback preceding the initial validity read.

## Verification

Source: `48e99c03e53aeec56483ae885b3aee2fa3f704ed`; [execution metadata and file hashes](execution.json). Documentation and receipts were added after this source revision.

| Check | Result / receipt |
|---|---|
| `pnpm typecheck` | [Passed](typecheck.txt) |
| `pnpm test` | [130 passed: 12 baseline + 118 additional, zero failures](backend-tests.txt) |
| Verifier rejection cases | [2 passed](verifier-negative.txt) |
| Isolated J001 | [Passed](J001.txt) |
| Isolated J002 | [Passed](J002.txt), [database/runtime receipt](J002-receipt.json) |
| Isolated J003 | [Passed](J003.txt), [database/runtime receipt](J003-receipt.json) |

Journey receipts retain their actual earlier source revision and dirty-state marker. Subsequent changes touched only new, unwired reasoning primitives and their tests; ordinary journey paths did not change. Integration CI reruns the complete backend/journey suite and Android build, lint and unit checks at the final PR head. CI outcome belongs in the PR and issue handoff, not an anticipated result here.

## Integrated observation

The real local HTTP fixture test checks that dispatch intent and Permit consumption are committed before the server receives the request. While its response is pending, another database transaction clears private history. The late synthetic usage settles the original old-epoch identity; private Job/Step/context/Attempt rows stay erased, output stays withdrawn, bucket totals settle once and reauthorization fails. The server observes exactly one request.

This executes actual PostgreSQL and loopback HTTP in one test process. Fixture responses are not provider evidence. No process is killed in this test, and it is not J004.

## Limits and next action

No live provider call, product dispatch, public receipt endpoint, fair scheduler, automatic retry, Job/Step success application, context compiler, proposal validator, private-graph retirement or scheduled retention worker is introduced. Trusted server callbacks own route and context authority; test callbacks are explicit fixtures. Product `ReasoningProvider` remains unready.

[#46](https://github.com/KnowScroll/knowscroll/issues/46) must prove J004's separate-process crashes, lost acknowledgements, no resend, stale worker fences, late usage and cleanup before the new protocol is considered usable in a synthetic runtime harness. Parent #7 stays open. See the [runtime guide](../../../operations/reasoning-runtime.md) and [implementation plan](../../../operations/reasoning-implementation-plan.md).
