# Wave four — MiniMax development certification

Date: 2026-09-16. Coordination [#37](https://github.com/KnowScroll/knowscroll/issues/37), implementation children [#38](https://github.com/KnowScroll/knowscroll/issues/38) and [#39](https://github.com/KnowScroll/knowscroll/issues/39), parent [#7](https://github.com/KnowScroll/knowscroll/issues/7).

## Scope

AI SDK 7.0.102 and the official MiniMax provider 0.0.2 on the Anthropic-compatible route. The adapter, file journal and explicit CLI are development tools. No owner context, database migration, ordinary reasoning job, semantic proposal application or Android behavior changes are part of this wave.

Two isolated Sol workers implemented adapter and journal/runner. A Terra worker researched official sources and independently reviewed the runner. Coordinator reviewed actual diffs and owned shared contracts, dependency pins, integration and live execution. Adapter review removed synthesized usage and added exact two-invocation native continuation, raw-usage retention on SDK failure and mutation tests. Runner review tightened exported journal fields, successful stop reasons, thinking evidence and dispatch/timeout truth.

## How to interpret evidence

The offline HTTP server is a test fixture, never provider evidence. It observes the real SDK wire body and the durable reservation before each transport request. Only the separately identified live run can establish compatibility with MiniMax at the recorded time.

Public receipts contain hashes, finite statuses, case booleans and nullable usage. No prompts, generated output, opaque thinking, raw provider IDs, headers or credentials are retained. The synthetic prompt definitions are in the runner source. Local JSON validation proves these small examples, not a provider-enforced structured-schema guarantee. A response/content hash is a correlation aid, not independent semantic verification.

The hard run ceiling is four requests and 100,000 reserved units, with per-call caps yielding a tighter 81,920 maximum. The implemented suite has only three cases, no repair or retry. Input reservation uses serialized UTF-8 bytes plus the output ceiling; this conservative reservation is different from actual provider-reported usage. Quota checks are observations of a shared plan, not vendor-side reservations. Unknown usage remains null and dollar cost is not inferred.

## Remaining scope

Full Job → Step → Attempt admission, database reservations, leases/fences, fairness, cancellation with late usage, privacy-bound context, semantic read sets and deterministic proposal application remain in #7. Streaming, vision, remote cancellation, idempotency lookup, long-horizon behavior, pricing and production suitability are unproved. The ordinary ReasoningProvider remains unready. No physical-device or new Android runtime claim follows from this backend-only wave.

## Verified results

The live experiment ran from `53657bf88128d32038600cd6145a17fcc96bae21`, 06:27:48–06:27:53 UTC on September 16. [Execution metadata](live-execution.json) pins the exact production-source hashes; the subsequent commit changes only timeout-test timing. [Sanitized live report](live-report.json) records run `ba8ce143-ee5f-418e-ac19-81479e9286d0`:

| Case | Result | Input tokens | Output tokens | Cache-read tokens |
|---|---|---:|---:|---:|
| Locally validated exact JSON | HTTP 200; all checks passed | 60 | 13 | 128 |
| Typed tool call with native thinking | HTTP 200; all checks passed | 281 | 55 | 165 |
| Native continuation and matching tool result | HTTP 200; all checks passed | 81 | 13 | 445 |

Provider-reported totals are 422 input, 81 output and 738 cache-read tokens, kept as separate fields; all cache-write fields were zero. Dollar cost remains null. Three requests reserved 6,360 units. No fourth request, repair, retry, automatic tool execution or owner context was used. Each call passed a fresh quota preflight. The [post-run quota observation](quota-after.json) reports 99% interval and 95% weekly remaining; shared-plan activity and quota rounding prevent attributing that percentage change to these calls alone.

Read-only `--inspect` reproduced the live report byte-for-JSON-value; local run and journal modes were verified as 0700/0600. Inspection did not invoke the provider. The [default refusal check](default-refusal.json) returned exit 2 and created no run.

| Check | Result / receipt |
|---|---|
| `pnpm typecheck` | [Passed](typecheck.txt) |
| `pnpm test` | [66 passed: 12 baseline + 54 additional](backend-tests.txt) |
| Three certification test files | [28 passed](certification-tests.txt), included in the 66 above |
| Journey verifier rejection tests | [2 passed](verifier-negative.txt) |
| Isolated J001 | [Passed](J001.txt) |
| Isolated J002 | [Passed](J002.txt), [receipt](j002-receipt.json) |
| Isolated J003 | [Passed](J003.txt), [receipt](j003-receipt.json) |

Adapter [PR #40](https://github.com/KnowScroll/knowscroll/pull/40) and runner [PR #41](https://github.com/KnowScroll/knowscroll/pull/41) merged after exact-head backend and Android checks passed. Full combined tests were rerun after the final timeout fix. No Android source changed; CI supplies build/lint/unit regression proof, while the earlier wave-three emulator evidence remains historical.

## Next action

[#42](https://github.com/KnowScroll/knowscroll/issues/42) defines the next bounded design gate: production admission, attempts/reservations, dispatch uncertainty, cancellation/late usage and privacy retention. #7 stays open. Successful certification does not connect model output to product state.
