# J004 interruption cleanup diagnostics — issue #57

Date: September 16, 2026. This evidence diagnoses the intermittent missing cleanup acknowledgement reported in [issue #57](https://github.com/KnowScroll/knowscroll/issues/57). It is scoped to the disposable local J004 harness and does not change product reasoning, schemas, migrations or provider behavior.

## Observed survivors

Before implementation, runner PID `59337` from the reasoning worktree was absent while its manifest still named live detached fixture PID/process group `59355` and API PID/process group `59356`. They listened only on dynamic loopback ports `57936` and `45359`, shared the empty disposable temp directory `knowscroll-j004-rqKI6h`, and retained disposable database `knowscroll_j004_264d0ab9530f9ab2`. Their metadata and originating manifest were inspected before cleanup. Only those two process groups, that exact database and that temp directory were removed. The owner API `52641`, worker `52642` and emulator `90895` remained running.

## Demonstrated failure and conclusion

At unchanged source revision `bc5055350430e6a334ee238182bb54aef4b958be`, a bounded driver waited for the J004 ready barrier, sent two `SIGTERM` signals 25 ms apart, and observed the runner exit by `SIGTERM`. The final manifest still lacked `cleanedUp`, although independent pre-fallback checks found the disposable database and every recorded child process group absent. The [source-stamped failing receipt](before-repeated-signal.json) reproduces the issue's exact missing-acknowledgement symptom.

The runner used `process.once` for each signal. The first `SIGTERM` removed that handler while asynchronous cleanup continued; the second restored the default terminating behavior and could end the runner before its atomic final-manifest write. This is a demonstrated cause for the repeated-signal case. The failed historical CI job did not record a second signal, so its root cause remains unknown.

## Implemented policy

`SIGTERM` and `SIGINT` received during cleanup are idempotent cleanup requests. Both handlers remain installed until the final cleanup manifest is durable. The independent checker now covers single `SIGTERM`, single `SIGINT`, repeated `SIGTERM`, mixed `SIGTERM`/`SIGINT`, and actual child `SIGKILL` after the ready barrier.

Every case still requires all of the following independently:

- a nonzero runner exit with an expected enumerated failure classification;
- explicit `cleanedUp: true` acknowledgement and no runner cleanup-error classification;
- absence of every recorded child PID and process group;
- absence of the runner and disposable database.

The checker records the runner exit code/signal and only allowlisted classifications. It drains child stderr without retaining or printing it; evidence contains only a byte count capped at 8 KiB plus a truncation flag. Missing, unknown, oversized or malformed runner diagnostics fail as `invalid_runner_diagnostic`. Fallback cleanup remains leak prevention after a failed observation and never converts failure into passing evidence.

## Verification

Source revision `5d677f26740c5da8e6f51bc9ef0d91dec7efe234` was clean for the final runtime checks. The [passing interruption receipt](after-interruption-matrix.json) records exact source hashes and all five cases. Three predeclared checker executions passed on their first attempt, for 15 total case observations; no failed execution was rerun until green. [Execution metadata](execution.json) pins all three receipt hashes.

| Check | Result |
|---|---|
| `pnpm typecheck` | Passed |
| `pnpm test` | Passed: 12 baseline plus 160 additional backend tests |
| J004 runner and source/state verifier | Passed: 13 cases, four fixture requests, source hashes matched |
| Interruption checker execution 1 | Passed: five cases |
| Interruption checker execution 2 | Passed: five cases |
| Interruption checker execution 3 | Passed: five cases |

The final implementation receipt records `cleanedUp: true`, absent process groups, absent runner and absent disposable database for every case. Each interrupted runner exited with code 1 and no signal after completing cleanup. The repeated same-signal and mixed-signal cases classified as `interrupted`; the child-SIGKILL case classified as `child_process_exit`. No cleanup-error classification was present.

## Limits

These observations are macOS arm64 local evidence against PostgreSQL on loopback. Linux evidence remains for CI at the reviewed PR head. Killing the runner itself with `SIGKILL`, host loss, production process supervision, provider execution and remote cancellation remain outside this claim. No live provider call or owner database mutation occurred.

## PR #59 Linux follow-up

The PR #59 Linux backend job `104799710534` later failed the single-`SIGINT` case after the ready barrier. The runner exited with code 1 and no signal, its process groups were absent, and its disposable database remained until checker fallback removed it. The last manifest had no final diagnostic or cleanup acknowledgement. The checker had consumed at least 8 KiB of stderr, but the workflow correctly did not retain arbitrary stderr. Consequently, the exact cause of that CI failure remains unknown; it must not be relabeled as the previously demonstrated repeated-signal failure.

A separate disposable-database probe demonstrated another abrupt-exit path with the same process-level signature: `node-postgres` emits idle-client failures as a pool `error` event, and Node exited with code 1 and no signal when the local J004 harness had no listener. The same probe with a listener retained control and recorded a typed condition. This establishes the defect in the harness, but the missing Linux stderr means it does not establish that this defect caused job `104799710534`. [The bounded analysis](linux-followup-analysis.json) preserves that distinction.

The local J004 runner now gives its own pool a harness-only application name, handles pool errors without recording the error payload, wakes the interruption barrier, and classifies the failure as `pool_runtime_error`. Cleanup checkpoints use an allowlisted stage and never set `cleanedUp`; only the final manifest can acknowledge cleanup. The checker has a sixth end-to-end case that terminates only the runner's disposable pool backend and still requires the typed nonzero failure, `cleanedUp: true`, no cleanup errors, and independent absence of the database, child process groups, and runner. It also maps stderr to a fixed allowlist while retaining only the previous bounded byte count and truncation flag.

One post-change local matrix run passed all original five cases plus the injected pool failure. Its [source-stamped receipt](after-linux-followup-local-matrix.json) records exact dirty-source hashes. Linux confirmation remains pending at a reviewed commit; no failed check was rerun unchanged.
