# ADR-0019 — Seven-day completed/failed private-context retirement

Date: 2026-09-19. Status: accepted for #81 after independent MiniMax M3 review of `aaa3931` and the clarifications below; implementation and process evidence are linked below. Extends ADR-0015/0018 without changing their recorded evidence.

## Owner decision and scope

The owner selected seven days after completion or failure for private prompts, frozen context and unsaved outputs. The interval is168 elapsed hours on the database clock. Immediate Clear History, saved user-visible content/source history and minimal accounting have separate policies. Unknown liabilities do not expire by age. This prerequisite does not enable paid jobs, certify an answer, publish outputs or create a completion endpoint.

Current private reasoning storage has no ordinary product completion consumer. This slice supplies the retention clock/storage guard and maintenance integration for a future trusted consumer; SQL fixtures exercise actual transitions. A future completion consumer must validate/apply an output through its own accepted contract before marking the Job completed. Merely observing a provider response never establishes product success.

## Authoritative terminal clock

Reserve new migration0012 after verified main0011; never edit old migrations. Add nullable `reasoning_job.finished_at` and an index for non-null candidate IDs. Existing rows remain null. The new column may coexist in the schema with withdrawn_at but one Job cannot have both timestamps. Existing cancelled/expired withdrawal semantics and their trigger remain unchanged. A new CHECK constraint explicitly requires finished_at to imply completed/failed status and withdrawn_at IS NULL; the new finished-clock trigger also rejects adding a withdrawal clock to a stamped Job. Do not edit migration0011 or broaden the old withdrawal guard to enforce this new field.

A BEFORE INSERT/UPDATE trigger supplies the finished clock automatically when a Job changes from running/waiting into completed/failed. It requires the old positive fence and live owner lease, unchanged fence, no new lease, no withdrawal clock, no fair-ready row, only terminal Steps, and only inactive Attempts whose retained accounting exists, has withdrawn output authority and state not_sent/unknown/responded. Caller-supplied finished_at on that valid transition is ignored and replaced by clock_timestamp(). A supplied finished_at on any other unstamped transition or insertion is rejected. Existing terminal rows cannot acquire a retrospective clock. Terminal insertions with a null clock remain deliberately unretirable; ordinary authoring creates queued Jobs, and an import/legacy row is not completion evidence.

Once stamped, finished_at, completed/failed status and lease fence are immutable; the Job cannot regain a lease, acquire a withdrawal clock or reactivate. Exact no-op updates retain the original timestamp. An unstamped legacy terminal row does not gain a timestamp through an unrelated update, repeated terminal assignment or migration. No creation/deadline/updated-time substitution or automatic backfill.

This guard establishes only a safe private-retention origin. It does not itself authenticate a service, resolve provider uncertainty, deactivate Attempts, close permits, terminalize Steps, remove fairness membership, release resources or claim/apply results. A future trusted terminal consumer must already own universe→Job→sorted private/accounting rows and satisfy these conditions atomically. An expired lease cannot establish a new clock; recovery/withdrawal uses the existing lifecycle. The final trigger checks use database time after earlier waits and acquire no additional row locks.

## Maintenance

Keep the current expiry→private Job→closed accounting lane rotation and the existing retiredJobs aggregate. The private Job discovery predicate is `(withdrawn_at IS NOT NULL OR finished_at IS NOT NULL)` using the same ID cursor. The eligible time/status predicate is exactly either:

- cancelled/expired AND withdrawn_at <= clock_timestamp() - interval '168 hours', finished_at IS NULL; or
- completed/failed AND finished_at <= clock_timestamp() - interval '168 hours', withdrawn_at IS NULL.

Do not use COALESCE to hide mixed clocks or infer a clock for legacy rows. Both branches share all existing safety checks: no lease/fair-ready membership; every Step terminal; every Attempt inactive with retained accounting and withdrawn output authority in not_sent/unknown/responded; same graph bounds. Lock universe with SKIP LOCKED before Job and sorted private/accounting rows, then repeat the complete predicate after lock waits without taking new locks. No forced repair or partial erasure for unsafe/oversized graphs. Existing maxProbes1–128, keyset wrap/advance, rollback and graceful process shutdown stay unchanged.

Delete only Attempts→Steps→contexts→Job with existing deferred constraints and cascades, including sealed payload/read-set/session binding. Shared source assets, Ledger/Ask/Trace history and saved/public output records are not deletion targets. Retained accounting/permits/reservations/receipts/settlement/fairness debt remain byte-for-byte unchanged. Unknown liability survives; late usage may settle original accounting and cannot recreate private context or regain output authority. The separate accounting purge still requires all duties closed for30 days and no private Attempt.

## Acceptance

Real PostgreSQL proves both outcomes, automatic clock and caller-time rejection, immutable state/fence/clock, null-clock legacy exclusion, rollback, early/boundary/late eligibility, all unsafe predicates and graph limits, universe/child waits and post-wait rechecks, unchanged liabilities/debt and late settlement, immediate Clear/replay, and old withdrawn/accounting lanes. A populated0011→0012 migration preserves old rows/columns and all11 checksums. A separate maintenance process exercises both newly eligible outcomes and cleanup. Coordinator owns migration, shared maintenance changes and process proof; independent review is mandatory before merge. Fixtures may age clocks only via explicit test-only trigger bypass in disposable databases, never in owner data. No claim of a seven-day wall-clock soak follows.

## Limits

No owner deployment, provider calls, saved-output retention policy, completion/application authority, new public route or full-v1 claim. Future storage for unsaved private outputs must join this erasure graph before product use; current absent output storage cannot be claimed deleted. Legacy rows without a trusted finish clock remain a visible conservative limit.

## Independent review disposition

The MiniMax M3 review accepted the policy with three clarifications. Mutual exclusion is explicitly enforced by the new CHECK and finished trigger, not merely inferred from disjoint statuses; old applied migration0011 remains immutable. Migration and maintenance eligibility/discovery ship in one reviewed PR. A single shared two-branch SQL predicate used before and after waits is equivalent to separate eligibility functions and avoids divergence. Any non-null finished_at supplied on a legacy/repeated/invalid transition is rejected; ordinary no-op legacy updates remain null. The existing withdrawn-fence policy is unchanged; this slice does not silently retrofit a separate lifecycle invariant. The reviewer performed a static design review, not runtime verification.

## Implementation evidence

[SQL and separate-process evidence](../journeys/evidence/terminal-retirement/README.md) records exact tested revisions, independent review and limitations. The final clock guard captures database time after safety inspection and requires the original lease to remain live at that instant. A blocked-safety-relation test proves expiry during the wait cannot establish a finish clock.
