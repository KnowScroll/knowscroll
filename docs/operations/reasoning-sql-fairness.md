# Durable reasoning fairness

Issue [#55](https://github.com/KnowScroll/knowscroll/issues/55) implements the [ADR-0013](../decisions/0013-bounded-reasoning-fairness.md) service policy in PostgreSQL. `createReasoningFairness(pool, authority)` is an internal development API. It admits metadata and reservations; it does not invoke a provider. The ordinary worker continues processing deterministic keeps and `reasoningReadiness()` remains false.

## Policy and queue authority

`installPolicy` stores a strict policy and its complete hash. The five class weights are fixed at 5:6:4:3:2; universes have equal weight within a class. Policy configuration includes quantum, maximum charge, scale, fixed input/output/combined-token/request bases and bounded probes/admissions. Reusing a version with another configuration fails. The database forbids policy mutation.

`enqueue` accepts only trusted internal request metadata matching an existing queued Job, pending Step, context, universe/epoch and server-assigned class. It preserves stable sequence order and an immutable private ready record. Request bodies, prompts, provider credentials and provider output are absent. Invalid or oversized normalized requests fail explicitly; no alternate large-work lane exists.

The ready index tracks active universe membership separately from retained accounting. Candidate discovery performs indexed keyset queries, each limited to one universe or one queue head. It does not filter an arbitrarily long invalid backlog before applying LIMIT. Expired, stale, impossible and blocked heads are inspected and reported. Physical impossibility removes the ready entry without inventing a successful or terminal Job transition; a trusted caller must explicitly reshape/re-enqueue or cancel it.

## One probe, one short transaction

`schedule` currently returns at most one admitted Attempt. It may inspect up to `maxProbes` heads or empty scopes; all such probes count. A fresh call resumes persisted class and universe turns. `maxAdmissions` remains an upper bound, not a promise to fill a batch.

1. Read the policy, cursor generation and one advisory candidate.
2. Acquire its universe with `SKIP LOCKED`, then the immutable bound context session before its Job and Step. Recheck scope, context, deadline and route authority.
3. Lock the policy scheduler and compare the observed generation. A changed generation rolls back and consumes a probe before rediscovery.
4. Lock the complete physical bucket set in UUID order. Recheck policy, context and database deadlines after waiting. A class/universe may earn its next quantum only when this complete vector fits; fairness credit itself is excluded from that eligibility test.
5. Open or resume the bounded turn. If credit is insufficient, persist the earned visit and rotate, without a claim or Permit. Debt survives this transition. A saved inner turn survives an outer class yield without another quantum.
6. If both balances and spend allowances fit, claim/fence the Job, reserve the complete vector, create Attempt/Permit and retained accounting, debit fairness, and advance ready/cursor state in the same transaction. Any failure rolls all of these changes back, including newly earned credit.

The internal `preflightAttemptInTransaction` and `reserveAttemptInTransaction` seams compose into this transaction. They must not be called with a network callback, commit independently, or be wrapped around an already separately committed claim. The existing split primitives remain for their earlier development fault harness; fair admission uses the combined path.

Lock order is universe → original context session when bound → Job → Step → existing Attempt/accounting → shared scheduler versions in sorted order → class/universe fairness rows → physical bucket UUIDs. New Attempt/Permit rows are inserted within that transaction. Operations affecting several Attempts lock the union of scheduler resources before their physical buckets. No code acquires another universe while holding a shared scheduler row.

Each successful or progress-only mutation changes the scheduler generation. A scan exhaustion yields only the exact generation/class that this worker progressed; it cannot skip a returner inserted by another transaction or advance an already-advanced class a second time. The result includes bounded observations distinguishing ineligible, impossible, locked, credit-waiting, capacity-exhausted, paused and scan-exhausted outcomes, with inspected queue age/deadline observations. Exhaustion is not proof of queue absence.

## Accounting, privacy and windows

Migration 0006 adds policy, scheduler, class/universe balances, private ready entries, retained Attempt charges and append-only correction deltas. Migrations 0001–0005 remain unchanged. A composite database foreign key binds a retained fairness Attempt to the accounting identity's universe.

Authenticated cumulative receipt settlement reuses the original policy and conservative estimates for still-unknown usage. Each accepted settlement revision posts only the difference from its previously recognized charge. Positive refunds are capped and discarded excess is recorded; negative debt is retained. A proven `not_sent` closure uses revision zero and refunds once. Admission creates no settlement delta. Unknown dispatches retain their charge, financial liability and remote slots across recovery/restart.

Physical bucket identities already include immutable window bindings. New route-selected windows use new bucket rows; late receipts update the original rows. Tests can prove A/B isolation without claiming that an automatic provider rollover clock exists. Selecting and calibrating an actual deployment route/window policy remains a later gate.

Clear history removes private ready rows with the execution graph, clears open memberships/cursors and drops positive idle credit while preserving debt and minimal original accounting. Balances are keyed by policy/class/universe across epochs, so clearing cannot evade debt. A late old-epoch receipt can adjust that retained balance once, but cannot create queue membership, context, output or a new dispatch. Exact earlier clear replay remains an early no-op. Scheduled retirement and broader privacy controls remain separate work.

## Verification and limits

Run the focused PostgreSQL tests in a disposable `knowscroll_test_*` database, then the full suite and isolated J001–J004/cleanup regressions. The pure model supplies counterexamples and service expectations; it is not SQL proof.

`pnpm exec tsx scripts/fairness/sql-restart.ts` starts a new temporary PostgreSQL cluster on a dynamic loopback port, upgrades a populated five-migration database, admits a synthetic unknown Attempt, stops/restarts that database process, compares durable snapshots, resumes work and checks receipt replay. It never restarts the shared development cluster. Its receipt states the exact source hashes and cleanup result. A fast PostgreSQL restart is not power-loss, storage-corruption, provider-execution or user-usefulness proof.

The service claim remains conditional on finite eligible sets, fitting work, available physical capacity and no unresolved debt/pauses. Unknown remote calls and permanent overload can block service indefinitely. No elapsed-time fairness, throughput, production-scale or personalized usefulness claim follows from these tests. Context/proposal authorization, lifecycle cleanup/disclosures and a separately bounded product-provider experiment remain required before product enablement.
