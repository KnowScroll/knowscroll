# ADR-0015 — Seven-day retirement of withdrawn reasoning jobs

Date: 2026-09-16. Status: owner retention choice accepted; implementation contract under independent review for #62. Extends ADR-0012. No provider or proposal enablement.

## Context and decision

The owner explicitly selected seven days for safely withdrawn cancelled/expired-job private context. Clear History continues to erase immediately. Completed/failed jobs, user-facing explanation history, account deletion and backup erasure remain outside this policy.

Migration 0008 adds nullable `reasoning_job.withdrawn_at`. The existing fenced `withdrawJob` operation requests a clock stamp only after it closes unconsumed work, withdraws possible output, deactivates Attempts, terminalizes Steps and clears the lease. A database trigger requires the old live lease, validates the safe transition and sets database `clock_timestamp()`, ignoring caller-supplied time. Once stamped the clock and terminal state cannot change or reactivate. New Jobs cannot supply a stamp. Pre-existing terminal rows stay null: neither creation nor deadline proves when safe withdrawal occurred. No automatic backfill invents history.

At or after 168 elapsed hours (`interval '168 hours'`, independent of daylight-saving calendar days) from that database timestamp, maintenance may erase the private graph if the Job is still cancelled/expired with no lease or fair-ready membership, every Step is terminal (succeeded/failed/cancelled/superseded), every Attempt is inactive and its accounting output is withdrawn with state not_sent/unknown/responded. A deadline alone never constitutes withdrawal. The existing withdrawal API still requires its current owner and lease fence; recovered waiting Jobs without a lease cannot use it and remain retained. The database trigger’s structural allowance for waiting is not new cancellation authority. That future lifecycle path is outside #62. No forced repair of an ineligible Job occurs.

## Transaction and bounded execution

`createReasoningMaintenance(pool).runBatch({maxProbes})` is a trusted internal operation, default 32 probes, allowed 1–128. Each probe is its own short transaction. Candidate discovery reads at most one ID with a keyset query. Job and accounting lanes alternate; separate process-memory cursors advance on selected, ineligible or locked candidates and wrap at the end. No payload, identity, cursor or raw error is emitted in logs. Cursors are not persisted and reset after process restart; there is no progress SLA across repeated restarts or query-planner physical-read bound.

A probe locks the candidate's universe with SKIP LOCKED before any Job/Step/Attempt/accounting row, then reselects current facts. A blocked universe does not block another candidate. Lock/statement timeouts bound anomalous contention; no external call occurs inside a transaction. Private retirement locks Job, Steps, Attempts and accounting in stable order, rechecks the full predicate and deletes inactive Attempts → Steps → contexts → Job in one transaction with deferred constraints. Context payload/read/seal and session bindings cascade. Reject oversized private graphs before loading all children: at most 128 Steps, 128 Attempts, 128 contexts and 16,384 combined typed/legacy reads per Job; overflow remains retained and is counted as skipped, never partially erased. The graph bounds are maintenance limits, not new authoring permission.

Retirement leaves accounting, permits, reservation states, receipt/settlement evidence, fairness counters/debt and shared assets untouched. Missing accounting is a refusal. Unknown remote/financial liability survives unchanged. Late original usage can settle retained identity without recreating private rows or regaining output authority. There is no Attempt cancellation, capacity release, provider retry or policy-risk closure in this operation.

The independent accounting lane invokes the existing bounded 30-day purge only after all financial, remote, reconciliation and idempotency duties close and no private Attempt survives. The database clock starts at the existing final all-duties-closed transition, not at private retirement. New evidence can reopen duties. Unknown liabilities have no automatic expiry.

## Service and privacy

A separate `apps/worker/src/reasoning/maintenance-main.ts` entrypoint schedules batches, with fixed default 60-second interval and graceful SIGINT/SIGTERM shutdown after the current bounded transaction. The deterministic projection worker is unchanged. An explicit CLI/environment option may choose a shorter positive interval for disposable verification; it cannot shorten seven/30-day SQL retention. It logs aggregate probe/retirement/purge/skip counts and fixed error codes only. No new provider keys or HTTP endpoint.

The separate process is exercised against disposable PostgreSQL before release. Installing code does not prove that a long-running owner maintenance service is deployed. Scheduling against owner data is a deliberate operator launch using this accepted policy, not an incidental change to the existing worker.

## Alternatives and verification

Immediate erasure and retention until Clear History were considered; the owner selected seven days. A process clock, creation/deadline proxy, or fabricated backfill was rejected because each can erase earlier than the accepted policy. Sharing the projection loop was rejected to keep maintenance failure/latency separate.

Real PostgreSQL tests must prove authoritative timestamps, early refusal, rollback, bounded probes, independent clients, locked-universe progress, exclusion of unsafe/oversized graphs, unchanged unknown reservations and debt, late usage, immediate clear/replay behavior and separate all-duties retention. A separate-process disposable receipt proves scheduling/shutdown and observed deletion, not live provider behavior, production capacity or completed-job retention.
