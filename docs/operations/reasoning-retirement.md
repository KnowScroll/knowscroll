# Withdrawn reasoning context retention

Issue [#62](https://github.com/KnowScroll/knowscroll/issues/62) implements the owner's seven-day choice in [ADR-0015](../decisions/0015-withdrawn-reasoning-retirement.md). It covers private reasoning graphs safely withdrawn as cancelled or expired. Clear History still erases private context immediately; completed/failed-job retention and account/backup deletion remain separate decisions.

## Clock and eligibility

The existing fenced `withdrawJob` operation closes unconsumed work, withdraws output authority, deactivates Attempts and terminalizes Steps before setting a retention timestamp. Migration 0008 requires a live old lease and a safe transition, substitutes PostgreSQL time for any supplied value, and prevents timestamp changes or reactivation. No creation/deadline proxy or backfill is used. Old terminal Jobs with no reliable timestamp stay retained. Recovered waiting Jobs without a lease cannot use the existing withdrawal API; this change grants no new cancellation authority.

Retirement becomes eligible after 168 elapsed hours. The maintenance transaction rechecks cancelled/expired status, no lease, no ready membership, terminal Steps, inactive Attempts, and withdrawn linked accounting in not_sent/unknown/responded state. Oversized or inconsistent graphs are skipped, never partially erased. The limit is 128 Steps, 128 Attempts, 128 contexts and 16,384 combined typed/legacy reads per Job.

Only private Attempts, Steps, contexts and Jobs are deleted; frozen bytes, dependencies and Job/session bindings cascade. Ledger, Keeps, saved Traces, shared assets, fairness debt, accounting, permits and reservations are unchanged. Unknown remote or financial liability does not expire at seven days. Late original usage can settle retained accounting without restoring private state.

A separate sweep uses the existing accounting rule: all duties closed for 30 database-clock days, all holds resolved and no private Attempt. A new receipt may reopen those duties. Neither private retirement nor age supplies provider-terminal evidence or refunds an unknown call.

## Running maintenance

Apply migrations through 0008 before starting the separate process:

```sh
. ./scripts/env.sh
pnpm db:migrate
pnpm maintenance:reasoning
```

The default schedule is one batch every 60 seconds, with 32 probes per batch. `REASONING_MAINTENANCE_INTERVAL_MS` accepts 100–3,600,000 milliseconds; `REASONING_MAINTENANCE_MAX_PROBES` accepts 1–128. These change scan scheduling only, never retention duration. Keep this process separate from `pnpm dev:worker`; the normal projection loop is unchanged. Logs contain aggregate counts and fixed errors, not Job/context identifiers or private bytes.

Every candidate consumes a probe. Private-job and accounting scans alternate, use keyset cursors in process memory and advance past locked/ineligible rows. Each transaction takes the universe lock first with SKIP LOCKED. A blocked universe does not stop another candidate. Cursor state resets at process restart; this is not a progress guarantee under repeated restarts, a query-planner scan bound or a production capacity claim. SIGINT/SIGTERM stops scheduling and allows the current bounded batch to finish before closing PostgreSQL connections.

## Verification and deployment limits

`pnpm exec tsx scripts/run-isolated-retirement-journey.ts` creates a new disposable database, compiles synthetic frozen contexts through the real compiler, admits/withdraws Attempts, and runs the separate maintenance process. Fixture-only timestamp aging tests due versus young retention; production has no age override. The runner checks unknown holds, late usage without resurrection, 30-day accounting purge, multiple scheduled batches and graceful shutdown, then removes its database.

The linked [evidence](../journeys/evidence/reasoning-retirement/README.md) records exact source hashes and results. Local/CI fixture success is not seven days of wall-clock observation, provider execution, owner service deployment or useful semantic reasoning. Product reasoning remains disabled. No owner history is cleared for verification.
