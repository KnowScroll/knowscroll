# J004 reasoning fault proof — issue #46

Date: September 16, 2026. Parent [#7](https://github.com/KnowScroll/knowscroll/issues/7), verification epic [#12](https://github.com/KnowScroll/knowscroll/issues/12), [issue #46](https://github.com/KnowScroll/knowscroll/issues/46). Read the [journey contract](../../../journeys/J004.md) and [runtime guide](../../../operations/reasoning-runtime.md).

## Outcome

The disposable harness executed 13 scenarios through the released SQL admission/reconciliation factories and the unwired worker invocation boundary. Four requests reached the separate local HTTP fixture. Its database query observed the matching committed intent and consumed Permit before recording each request. Actual SIGKILL exits, distinct recovery-worker PIDs, fresh SQL snapshots and original Attempt/request/dispatch/settlement identities are preserved in the [J004 receipt](J004-receipt.json).

The receipt's `source.revision` and file hashes identify the executed code. The CLI independently matched them to the checkout. [Execution metadata](execution.json) also pins the coordinator verifier and cleanup checker. Historical receipts retain their own observed revision and dirty marker rather than being relabelled as a later commit.

## Checks

| Check | Result / evidence |
|---|---|
| Typecheck | [Passed](typecheck.txt) |
| Backend tests | [149 passed: 12 baseline + 137 additional](backend-tests.txt) |
| J004 verifier counterexamples | 19 checks within the backend suite: valid receipt plus 18 corrupted receipts |
| Existing verifier rejection cases | [2 passed](verifier-negative.txt) |
| J001 | [Passed](J001.txt) |
| J002 | [Passed](J002.txt), [receipt](J002-receipt.json) |
| J003 | [Passed](J003.txt), [receipt](J003-receipt.json) |
| J004 + independent source/state verifier | [13 cases / 4 fixture requests passed](J004.txt) |
| SIGTERM and SIGINT interruption | [Passed](cleanup.txt), [independent OS/PostgreSQL observations](cleanup.json) |

CI repeats backend tests, J001–J004, independent interruption cleanup and Android build/lint/unit checks at the integration PR head. Its final result is recorded in the PR and issue handoff.

## Observed boundaries

- Unconsumed work closes as not_sent; consumed intent remains uncertain after worker death or a lost authorization acknowledgement. Original and replacement authorization retries are refused.
- A separate worker recovers after natural database-clock lease expiry and advances the fence. Stale A cannot authorize or change the private checkpoint. This proves recovery fencing, not automatic requeue or a new execution lease.
- Pre-dispatch cancel/expiry releases reservations; post-dispatch cancel/deadline withdraws output while financial and remote duties remain held. Late usage settles once.
- Real API clear removes nonempty private context/read-set/execution rows and fixture authority rows. Delayed original-epoch usage does not recreate them. Retrying the same clear after later reasoning activity returns the original receipt and preserves all later rows/balances.
- Exact receipt replay posts no extra charge. Nullable usage independently retains financial and remote holds. Known cumulative totals progress from 12 to 15 to 205 with deltas of 3 and 190; overage is retained and affected buckets pause. Conflicting/decreasing evidence cannot rewrite accepted totals.
- Concurrent shared-cap admission has one complete winner and no partial loser writes. A ready universe progresses while another universe row stays locked and unchanged.
- The independent interruption checker first observes live API/fixture/worker processes and an existing disposable database, sends SIGTERM or SIGINT, and then confirms every recorded PID/process group and database are absent.

## Review and ownership

Sol (`gpt-5.6-sol`) implemented the runner and fixtures in focused draft PR #52 and began cleanup hardening. It reached its model usage limit during that follow-up; the coordinator preserved and completed its changes. Terra (`gpt-5.6-terra`) independently reviewed the fault matrix, code and cleanup repair. The coordinator implemented the separate receipt verifier, 18 corruption counterexamples, interruption checker, CI integration, docs and combined verification.

Review replaced direct fence edits with actual recovery, added explicit replacement refusals and pre-dispatch cancel/expiry, required Permit evidence at HTTP arrival, and corrected cleanup failure handling. Cleanup now attempts all owned resources after an earlier failure, awaits process-group exit, closes bounded waits, releases the locked SQL client in finally and cannot report passing evidence when cleanup is unverified.

## Limits / next work

All responses are synthetic local fixtures. The lost-ack case injects a failure after actual SQL commit; it is not a network proxy dropping a PostgreSQL packet. Killing a worker is real process proof; graceful interruption cleanup does not cover host loss or SIGKILL of the runner itself.

No production module, migration, owner data or Android surface changes. No live provider call, fairness scheduler, automatic retry, proposal application, native product continuation or scheduled retention worker is introduced. Product ReasoningProvider remains unready. Continue with the bounded fairness/context/lifecycle gates in the [implementation plan](../../../operations/reasoning-implementation-plan.md); #7 remains open.
