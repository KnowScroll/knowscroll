# Private reasoning context retention

Issue [#62](https://github.com/KnowScroll/knowscroll/issues/62) implements the owner's seven-day choice in [ADR-0015](../decisions/0015-withdrawn-reasoning-retirement.md). It covers private reasoning graphs safely withdrawn as cancelled or expired. [ADR-0019/#81](../decisions/0019-completed-failed-private-retirement.md) extends the owner-approved168-hour policy to safely completed/failed private graphs. Clear History still erases private context immediately; saved user-visible content and account/backup deletion remain separate policies.

## Clock and eligibility

The existing fenced `withdrawJob` operation closes unconsumed work, withdraws output authority, deactivates Attempts and terminalizes Steps before setting a retention timestamp. Its migration 0008 branch requires a live old lease. [ADR-0018/#75](reasoning-idle-lifecycle.md) and migration 0011 add separate original-session cancellation and trusted actual-deadline expiry for bound idle direct Jobs; recovered waiting Jobs without a healthy lease use those internal helpers. All branches substitute PostgreSQL time, prevent timestamp changes/reactivation and require safe closure. No creation/deadline proxy or backfill is used. Old terminal Jobs with no reliable timestamp stay retained. The original #62 evidence and its narrower withdrawal authority remain historical records.

Completed/failed Jobs receive a separate database `finished_at` only on a safe running/waiting terminal transition with a live old lease, unchanged fence, closed private work and withdrawn output authority. The new trigger checks lease time again after inspecting safety. A new CHECK and trigger prohibit mixed clocks or reactivation; earlier withdrawal guards remain unchanged. Caller backdates cannot shorten retention; legacy null finish clocks are never backfilled. This is a storage guard for a future trusted completion consumer, not new answer/application authority.

Retirement becomes eligible after168 elapsed hours from withdrawn_at for cancelled/expired Jobs or finished_at for completed/failed Jobs, with the other clock null. The maintenance transaction rechecks the exact clock/status branch, no lease, no ready membership, terminal Steps, inactive Attempts, and withdrawn linked accounting in not_sent/unknown/responded state. Oversized or inconsistent graphs are skipped, never partially erased. The limit is 128 Steps, 128 Attempts, 128 contexts and 16,384 combined typed/legacy reads per Job.

Only private Attempts, Steps, contexts and Jobs are deleted; frozen bytes, dependencies and Job/session bindings cascade. Ledger, Keeps, saved Traces, shared assets, fairness debt, accounting, permits and reservations are unchanged. Unknown remote or financial liability does not expire at seven days. Late original usage can settle retained accounting without restoring private state.

A separate sweep uses the existing accounting rule: all duties closed for 30 database-clock days, all holds resolved and no private Attempt. A new receipt may reopen those duties. Neither private retirement nor age supplies provider-terminal evidence or refunds an unknown call.

## Running maintenance

Apply migrations through0012 before starting the current separate process. This is a deliberate deployment operation, not something verification runs on owner data:

```sh
. ./scripts/env.sh
pnpm db:migrate
pnpm maintenance:reasoning
```

The default schedule is one batch every 60 seconds, with 32 probes per batch. `REASONING_MAINTENANCE_INTERVAL_MS` accepts 100–3,600,000 milliseconds; `REASONING_MAINTENANCE_MAX_PROBES` accepts 1–128. These change scan scheduling only, never retention duration. Keep this process separate from `pnpm dev:worker`; the normal projection loop is unchanged. Logs contain aggregate counts and fixed errors, not Job/context identifiers or private bytes.

Every candidate consumes a probe. Actual-deadline idle expiry, private-job retirement and accounting scans rotate in that order, use separate keyset cursors in process memory and advance past selected locked/ineligible rows. Batch results include required `expiredJobs`, counting changed expiry commits only. Each transaction takes the universe lock first with SKIP LOCKED. A blocked universe does not stop another candidate. Cursor state resets at process restart; this is not a progress guarantee under repeated restarts, a query-planner scan bound or a production capacity claim. SIGINT/SIGTERM stops scheduling and allows the current bounded transaction to finish before closing PostgreSQL connections.

## Verification and deployment limits

`pnpm exec tsx scripts/run-isolated-retirement-journey.ts` creates a new disposable database, compiles synthetic frozen contexts through the real compiler, admits/withdraws Attempts, and runs the separate maintenance process. Fixture-only timestamp aging tests due versus young retention; production has no age override. The runner checks both completed/failed due graphs and young finished context, retained source history, unknown holds, late usage without resurrection, 30-day accounting purge, multiple scheduled batches and graceful shutdown, then removes its database. Safe finish transitions and clock aging are explicit local fixtures; there is no product completion or provider call.

The linked [evidence](../journeys/evidence/reasoning-retirement/README.md) records exact source hashes and results. Local/CI fixture success is not seven days of wall-clock observation, provider execution, owner service deployment or useful semantic reasoning. Product reasoning remains disabled. No owner history is cleared for verification.

Completed/failed successor evidence is recorded under [#81](../journeys/evidence/terminal-retirement/README.md). Earlier receipts retain their narrower tested scope and exact revisions. New private unsaved-output storage must join this erasure graph before product use; absence of that storage is not evidence that future output types are covered.
