# J004 first-observed failure classification — issue #57

## Retained Linux observation

At PR #65 head `0b88460ab4d8282736cd57c74a3796cf2e44f8f8`, [PR CI35112506042](https://github.com/KnowScroll/knowscroll/actions/runs/35112506042) failed the single-SIGINT case with `failure_classification_mismatch`. [The matrix](ci-before-matrix.json), [final manifest](ci-before-manifest.json) and [runner receipt](ci-before-runner-receipt.json) are original downloaded artifacts, not reconstructed evidence.

Cleanup itself succeeded: final acknowledgement, no cleanup errors, database absent, all child process groups absent, runner absent. All three child exits were0. The final manifest classified `pool_runtime_error`; the receipt reported its coarse `interrupted` outcome. The artifact did not retain event order or PostgreSQL error code, so it does not establish which event was first or why the pool emitted an error. [Sibling push CI35112499420](https://github.com/KnowScroll/knowscroll/actions/runs/35112499420) passed at the same head; neither run was an unchanged retry.

The inspected runner can overwrite failure classification in three places: the pool event callback, pause loop and catch priority. Its signal callback initially records only a boolean. A later pool event can therefore replace an earlier observed interruption. This source defect is separate from the older missing-acknowledgement failure; #57 remains open for that historical uncertainty.

No raw stderr, token or provider data is retained. Verification must keep expected primary classification, final cleanup acknowledgement, zero cleanup errors and independently absent database/runner/process groups. Fallback cleanup never turns a failed observation into passing evidence.

## Repair and independent verification

The first observed failure is now latched; later distinct classes retain their runtime/cleanup phase without replacing it. Final receipt and manifest use that same primary. The checker still rejects unexpected primary classification, missing acknowledgement, cleanup errors or surviving resources.

The [instrumented old-runner probe](instrumented-before-probe.json) preserves the original classification logic and adds one synthetic Pool.emit in cleanup after real SIGINT. It reproduces the overwritten primary while verifying completed cleanup independently. Its hashes and exact injection distinguish this from unmodified source or a natural PostgreSQL fault.

[Coordinator verification](execution.json) records 253 passing backend tests, typecheck and regression runs at clean `e481ea2`. The [eight-case interruption matrix](interruption-after.json) contains the six existing real signal/child/PostgreSQL-backend cases plus two explicitly synthetic handler-order probes. The latter prove Pool-before-interruption and interruption-before-cleanup-Pool behavior; they do not reconstruct CI timing. The [ordinary J004 receipt](j004-after.json) also passed its strict verifier. Sol (`gpt-5.6-sol`) implemented the two-file repair; Terra (`gpt-5.6-terra`) independently accepted the source.

No provider calls, production modules, migrations or owner data changed. Exact-head Linux backend and Android CI remain a separate release gate.

## Separate deadline fixture repair — issue #68

[Push CI35114786600](https://github.com/KnowScroll/knowscroll/actions/runs/35114786600) failed a pre-existing certification test that assumed loopback receipt within a30ms deadline. [The extracted failure](ci-deadline-before.json) records local dispatch but zero observed server arrivals. [Sibling PR CI35114795272](https://github.com/KnowScroll/knowscroll/actions/runs/35114795272) passed, including the [Linux eight-case cleanup matrix](linux-interruption-after.json); it was not used to bypass the failed push suite. The PR receipt's revision is GitHub's generated merge commit; file hashes match the reviewed repair.

The final test-only repair captures the adapter's first synchronous deadline callback and immediately restores native timers before SDK/fetch work. A real loopback request-arrival barrier precedes controlled callback firing and observed response close. A separate beforeDispatch barrier proves pre-transport expiry sends no request and retains unknown usage. This is a synthetic trigger of the actual adapter callback, not a60-second wall-clock experiment. No production adapter source changed.

[Coordinator proof](deadline-execution.json) at clean `39feb25` records typecheck,14 focused tests and254 full backend tests. Terra independently accepted Sol's `e5afcee` and ran14 focused tests. An [instrumented full-file stalled-barrier probe](deadline-stalled-barrier-probe.json) deliberately cancels the target at its5-second real test bound, passes the13 remaining tests and exits in5.77seconds under an external15-second bound.

The earlier global-MockTimers candidate [is explicitly rejected](rejected-global-timer-candidate.json): it hung in coordinator and reviewer full-file runs. Its isolated passing timeout probe was insufficient. Native timer restoration and fixture connection cleanup replace that approach. Final-head backend/Android CI remains required before merge. #68 can close after release; #57 retains its older unresolved incident.

## Retirement output drain and diagnostics — issue #69

[Three final-head Linux failures](retirement-shutdown-ci-before.json) reported the shutdown stage with final zero child exit, stopped acknowledgement, no stderr and completed database cleanup. The original diagnostics did not preserve the failed assertion or its earlier state; an exit/output race remains unconfirmed. Five instrumented old-runner local checks all passed and do not reproduce those Linux failures.

The harness now waits for both process exit and stdio close under bounds, then requires zero exit/close result, complete output framing, stopped acknowledgement, no stderr and both observed aggregate deletion counters. It retains the first sanitized shutdown failure and its state plus independent teardown failures. Worker stop, pool close, database drop/absence verification and admin close are attempted independently; fallback cannot make failed proof pass. Earlier pre-shutdown assertions may still retain a generic failure code.

A marker-gated child-process counterprobe observes parent exit before it releases the inherited stdout writer, proving `exit → data → close` without a timing margin. It establishes a possible mechanism only. [Coordinator verification](retirement-drain-execution.json) records typecheck,255 backend tests, that counterprobe and the [separate scheduled-process receipt](retirement-drained-process.json) at clean `6a75210`. Sol implemented and Terra independently accepted and tested the exact source. Product maintenance, migrations and provider behavior remain unchanged. Final-head Linux/Android CI is a separate gate; original failures remain preserved and unattributed.
