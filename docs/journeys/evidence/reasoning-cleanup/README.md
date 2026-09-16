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

Final source-stamped receipts and exact command results are added after the implementation commit is created. The first local implementation run already passed all five interruption cases, and the full 13-case J004 journey passed with four local fixture requests and matching source hashes.

## Limits

These observations are macOS arm64 local evidence against PostgreSQL on loopback. Linux evidence remains for CI at the reviewed PR head. Killing the runner itself with `SIGKILL`, host loss, production process supervision, provider execution and remote cancellation remain outside this claim. No live provider call or owner database mutation occurred.
