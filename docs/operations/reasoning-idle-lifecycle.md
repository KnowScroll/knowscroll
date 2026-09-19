# Idle direct Job cancellation and expiry

Issue [#75](https://github.com/KnowScroll/knowscroll/issues/75) implements [ADR-0018](../decisions/0018-idle-direct-job-withdrawal.md) for existing original-session-bound direct Jobs. These internal helpers create no execution request, answer or provider authority. Apply migration 0011 with the coordinated runtime release; migrations 0001–0010 remain unchanged. Owner service deployment requires a separate explicit operational record.

## Transaction contract

`cancelIdleDirectJob(client, authScope, {jobId})` follows `authenticateAndLock` on the same transaction/client. It requires the immutable original session, matching device/universe/current epoch and live unrevoked authority after resource waits. A second session cannot substitute. `expireIdleDirectJob(client, {jobId, universeId, privacyEpoch})` is a trusted scheduler/maintenance operation using the actual Job deadline and PostgreSQL time. It requires the original binding and current scope but allows an expired/revoked original session.

Both accept only queued or recovery-waiting `wake_kind='direct'` Jobs without a healthy worker lease. Running Jobs first use fenced recovery. The existing live-worker `withdrawJob` contract is unchanged. Cancellation is currently internal; there is no public cancellation route or UI.

Callers own BEGIN/COMMIT/ROLLBACK. An error must roll back the transaction: do not catch `isIdleWithdrawalIneligible` inside a transaction and commit earlier writes. Maintenance catches known refusals only after rollback. Scheduler alone uses the ADR's narrow savepoint whitelist and fully rolls back helper changes before a non-removing queue bypass; arbitrary SQL, authority, membership and CAS failures abort the entire probe.

Locks follow universe → original session → Job → sorted private children/accounting/permits/reservations → sorted fairness resource union and ready membership → sorted physical buckets. Final authority, deadline and fence rechecks acquire no new locks. Graphs above 128 Steps or 128 Attempts and inconsistent reservation/permit shapes are refused before mutation.

## Closure and scheduling

Proven unconsumed reservations close as `not_sent`, release physical reservations and receive at most one revision-zero fairness refund. Possibly sent dispatches become/remain `unknown`; output is withdrawn while financial liability and remote slots remain held. Authentic late original receipts may still settle retained accounting. Age alone never refunds unknown work.

After refunds, arbitrary ready removal preserves other candidates' order, open turns and allowances. Empty lanes clamp positive credit while retaining debt. The finalizer updates each changed policy generation once; a separate actual refund can increment it again. Steps become terminal, Attempts inactive, the lease clears, the fence advances exactly once, and the SQL guard stamps `withdrawn_at` using database time. Any failure restores the entire graph. Authorized same-transition replay performs no writes or clock change.

The fair scheduler distinguishes a shorter ready-request deadline from the Job deadline. An expired request alone is dequeued without expiring its still-live Job. Actual bound Job expiry invokes safe closure and suppresses the old snapshot's final class-yield write, including a single-probe run with refunds. Permanently oversized/unsafe heads can be bypassed without partial closure or deletion.

Maintenance rotates actual-deadline expiry → 168-hour private retirement → closed-accounting purge. Separate process-local keyset cursors advance on selected candidates, including skipped candidates. The total 1–128 probe budget and shutdown/disconnect rules remain unchanged. Every batch includes `expiredJobs`, counting only changed, committed transitions. Expiry can reach a Job whose ready request was previously dequeued.

## Evidence and limits

Real disposable PostgreSQL tests cover original-session authority and lock waits, healthy-worker refusal, recovery/unknown settlement, Clear, rollback, arbitrary queue removal, scheduler generation accounting, SQL guard bypasses and retirement without Ask replay resurrection. The [evidence record](../journeys/evidence/reasoning-idle-lifecycle/README.md) separates these checks from the separate maintenance-process and joined regression receipts.

No owner database is cleared or migrated by these tests. No provider call, paid authorization, mobile control or completed/failed retention policy is added. Fresh execution grants, result validation, retention for completed/failed work and bounded live-provider policy remain separate gates under #7/#72.
