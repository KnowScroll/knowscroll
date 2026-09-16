# ADR-0018 — Safely withdraw idle direct Jobs

Date: 2026-09-17. Status: proposed for #75; independent review pending. Extends ADR-0012/0015. Implementation must wait for acceptance of this contract.

## Boundary

Existing internal execution primitives can leave a queued or recovered waiting direct Job without a live worker lease. The original fenced `withdrawJob` cannot close it. This adds two internal transaction helpers for an already authorized, original-session-bound direct Job. No public endpoint, new Job, retry, provider grant, answer, proposal or mobile control is added. A recorded/replayed Ask remains source-only.

`cancelIdleDirectJob(client, authScope, {jobId})` requires `authenticateAndLock` on the same client/transaction. It revalidates the immutable original session, exact device, universe/current epoch and live unrevoked session after every relevant wait. A different session cannot cancel this Job. A missing original-session binding is ineligible; no binding is created or substituted.

`expireIdleDirectJob(client, {jobId, universeId, privacyEpoch})` is a trusted worker operation, never a client-authentication substitute. It locks the original session row even if expired/revoked, and requires the actual Job deadline to have elapsed according to PostgreSQL `clock_timestamp()`. It checks current universe/Job epoch and original binding; it does not refresh a session or grant execution authority.

Both helpers use the caller's existing transaction. They lock universe → original session → Job → sorted Steps → sorted Attempts/accounting → scheduler/fairness resources → sorted physical buckets. Initial immutable binding lookup is read-only. The cancel helper rejects a different original session before acquiring a second session lock. The last authority/deadline/lease recheck occurs after resource waits and acquires no new lock. Errors roll back the caller's entire transaction.

Only `class='direct'`, status `queued` or `waiting`, with no healthy lease is eligible. A healthy worker winning claim first causes refusal; this operation never interrupts it. Running Jobs, even with an expired lease, first use the existing fenced recovery path. Recovery-waiting work may retain unknown accounting. Old terminal Jobs with no authoritative clock remain untouched. Unbound legacy/background Jobs remain outside this new authority. Existing live-worker `withdrawJob` is unchanged.

## Atomic closure and replay

Before changing any state, check graph structure and lock all closure resources. Remove ready membership with exact scheduler generation/count/cursor/idle-credit bookkeeping; preserve negative fairness debt. Close a provably reserved, unconsumed Attempt as `not_sent` through existing release semantics. A consumed/dispatch-committed Attempt becomes `unknown`; existing unknown/response accounting remains retained. Withdraw output and deactivate private Attempts, terminalize unfinished Steps and clear the Job lease. Never refund a consumed reservation, remote concurrency or unknown liability by age. Late original usage settlement must remain possible after withdrawal and eventual private retirement.

Increment the lease fence exactly once on a new idle withdrawal, rejecting overflow. The final Job CAS rechecks original status, epoch, fence and absence of a healthy lease. The trusted expiry CAS also checks its real database deadline. Request `withdrawn_at` only after all closure predicates are satisfied. Rollback restores readiness, counters, reservations, Steps and the Job together.

The helper returns `{status: 'cancelled'|'expired', changed: boolean, closedNotSent: number, preservedUnknown: number}`. An authorized replay of the same already-stamped terminal transition returns `changed:false` and performs no new writes or clock change. Cancel replay still requires the original live session/current epoch. Expiry replay requires the original scoped Job/binding; no private record is recreated after retirement or Clear. A conflicting terminal reason or unstamped historical terminal row is ineligible. No separate cancellation request receipt is needed for this internal idempotent state transition. A future public cancellation API must define its own person-facing retry contract.

## Database guard

Main includes migrations0001–0010. Migration0011 will replace the withdrawal-clock guard, preserving all released files and its original live-lease branch. A second structural branch permits only the scoped/bound direct queued-or-waiting transition with no healthy lease, exact fence advancement, no ready membership, terminal Steps, inactive Attempts and withdrawn accounting in `not_sent|unknown|responded`. Cancellation additionally requires the original session live/current; expiry requires the actual database deadline. The guard independently verifies current universe/Job/binding scope. These SQL checks protect storage shape; trusted database access is not a public authentication API.

Caller time is ignored in favor of `clock_timestamp()`. Existing stamped rows cannot change the clock/reason or reactivate. INSERT cannot supply a clock, and existing unstamped terminal rows cannot be backfilled. The accepted168-hour retirement delay and retained-accounting policy are unchanged.

## Fair scheduler integration

Current fairness expiry uses the ready request's earlier deadline to mark the whole Job expired. The new direct-bound path reads actual Job deadline under its locks. If the Job deadline has elapsed, perform the same safe expiry before acquiring scheduler resources in the probe; use one transaction and one consistent readiness-accounting update. Never acquire new private locks after a scheduler lock. If only the ready request's deadline elapsed, dequeue that request with normal bookkeeping and leave the still-live Job queued; no automatic new request is created. Do not stamp an unbound/background Job through this new helper. Preserve the legacy out-of-scope behavior explicitly until its own lifecycle contract exists.

This issue supplies callable internal closure and the existing scheduler's direct-bound expiry path. A future production scheduler/maintenance deployment and public cancellation UX remain separate; the running owner process is not silently restarted.

## Verification and remaining decisions

Real disposable PostgreSQL checks cover queued and recovered unknown work; original-session substitution, expiry and revocation; foreign/old epoch; competing claim/reserve/dispatch/recovery, session/resource lock waits, deadline recheck, rollback, readiness/debt preservation, raw clock/fence tampering, Clear, authorized replay,168-hour retirement and late original usage. Independent privacy/concurrency review and existing joined reasoning/cleanup regressions are required. No live provider call.

Fresh execution authority, completed/failed private retention, actual route/model/budgets and bounded paid experiments remain undecided separate gates. This engineering contract makes no policy decision on them and does not complete #72.
