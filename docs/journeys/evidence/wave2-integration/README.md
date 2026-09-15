# Wave two — device sessions and privacy fences

Observed September 16, 2026 (India); UTC timestamps are retained in receipts. Coordination: [#21](https://github.com/KnowScroll/knowscroll/issues/21). Implementation: [#26](https://github.com/KnowScroll/knowscroll/pull/26) and [#25](https://github.com/KnowScroll/knowscroll/pull/25); J002: [#27](https://github.com/KnowScroll/knowscroll/pull/27).

## Reproduced behavior

- `pnpm typecheck` passed. `pnpm test` passed 30 tests: 12 bootstrap/migration checks and 18 session/API/epoch checks. [Output](backend-tests.txt) includes real PostgreSQL lock waits, migration preservation/rollback, scoped authorization, stale reference rejection, terminal discard, and progress in a second universe while the first is locked.
- `pnpm exec tsx --test scripts/journey-verifier.test.ts`: two negative verifier cases passed.
- `pnpm exec tsx scripts/run-isolated-journey.ts`: [J001 HTTP receipt](http-j001.json), separate worker, and deliberate wrong-database rejection passed.
- `pnpm exec tsx scripts/run-isolated-session-journey.ts`: [J002 receipt](http-j002.json). Universe A's obsolete job was discarded with zero projection changes; B's current job completed with one Trace and one revision increment. Private HTTP scope, foreign reference denial, expiry, revocation and retry behavior passed. The check list omits an explicit revocation label; the verifier's successful run includes its 204-revoke/401-follow-up assertions.
- SIGTERM after observing the separate worker start: [cancellation receipt](cancellation.json). Exit 1, zero new databases and zero new API/worker processes remaining.
- Local provisioning CLI: [receipt](cli.json). Mode 0600, token absent from output, existing-file and unignored Git destination rejected. Credentials and disposable database removed after verification.
- `python3 scripts/android-journey.py`: all five instrumentation phases passed on API36 arm64. [Environment](android-environment.json), [keep/return](android.json), and phase output files retain the evidence. Force-stop and cold relaunch restored reading position 516 and the same retry identity with one exposure and one keep. [Restored screen](android-restored.png) was visually inspected. No mobile source changed in this wave.

## Existing development history

Migration 0002 was applied to the regular development database only after the reviewed schema and API PRs merged. [Before](wave2-history-before.json) and [after](wave2-history-preserved.json) retain row counts and SHA-256 hashes of canonical sorted JSON for all eight original domain tables. The new `privacy_epoch` and `discarded_at` fields are excluded from comparison. Every existing value and row matched: one universe, one Accounts row, six decisions, five Ledger events, three exposures, two jobs, two Traces and three editorial assets.

The API and worker were restarted from merged implementation with provider credentials withheld. The existing token authenticated as an ordinary epoch-zero owner session. [Live observation](development-state.json) records the healthy API, fresh worker heartbeat, two completed jobs and both migration checksums at 19:41 UTC. The normal emulator app was cold-launched without clearing data; [owner screen](owner-universe.png) shows the same two Traces. These are dated observations, not promises that services remain running.

## Evidence limits

Git hashes in receipts identify the coordinator checkout used for each run; source hashes identify the implementation even when later documentation or test robustness commits changed HEAD. This does not prove public login/recovery, mobile session switching, destructive clear/delete/pause, retention policy, semantic proposal read sets, load capacity, physical-device behavior or usefulness. No MiniMax/Cutroom call occurred. The full semantic and cosmic/social target remains future product scope.
