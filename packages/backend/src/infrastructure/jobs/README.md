# infrastructure/jobs

pg-boss is the only work outbox (blueprint §19). Owns: the `pgboss` schema.

| Operation | Purpose |
|---|---|
| `defineQueue({...})` | Declares a queue `<module>.<operation>`: versioned ID-only payload schema, delivery policy (expiry, retries, backoff, retention, dead letter) and consumer policy (concurrency, polling). |
| `createBoss(settings, role)` | `install` (migrate command: creates/upgrades the schema), `producer` (API: sends only, no maintenance), `consumer` (worker: claims work and runs maintenance; never changes the schema). pg-boss keeps its own small pool. |
| `applyQueueDeclarations(boss, queues)` | Creates each queue and its `<name>.dead` queue, or brings an existing queue's policy in line, registers the queue's recurring `schedule` (cron, UTC) or removes a stale one, and deletes the schedule of any queue that is no longer declared (`queues` must be the complete registry). Returns the schedules it removed; `dist/migrate.js` logs each as `jobs.schedule_removed`. The one owner of schedules: idempotent, run once per deploy while the old release is quiesced. A queue dropped from the declarations otherwise keeps its schedule, which keeps creating jobs nobody claims; the queue and its jobs are left alone. Only the worker's (`consumer`) pg-boss instance runs schedules. |
| `makeEnqueueJob(boss)` → `enqueue(scope, queue, payload)` | The job port. Requires the open `PersonalScopeTx`; validates the payload; `boss.send(name, data, { db: fromKysely(trx) })` writes the job through the scope's own transaction, so a rollback removes the job with the state change. |
| `startConsumers(boss, consumers, logEvent)` | Registers the worker's explicit consumer registry and settles each job explicitly (`perJobResults`): success → completed; a payload that does not match its queue → dead-lettered at once (no retries); a handler failure → failed with a code-only output (`{failure, errorClass, code}`), retried or dead-lettered by the queue's policy. pg-boss never stores an error message, stack or driver detail. Failures are logged once (sanitised, no payload). |
| `drainConsumers(boss, count, timeoutMs, logEvent)` | Stops claiming, waits for running handlers (bounded), closes pg-boss. |
| `deleteJobPayloads(scope, queues)` | Erasure: deletes one universe's queued, active, retained and dead-lettered payloads from the named queues. |

Declared queues: `evidence.apply-action` and `evidence.project-scroll-reading` (evidence module),
`identity.sweep-sign-in-records` (identity; scheduled every 15 minutes: deletes expired sign-in links
and long-ended sessions), `reasoning.purge-expired-requests` (reasoning; scheduled every 15 minutes:
deletes protected model request bytes past their retention) and `reasoning.sweep-dispatched-attempts`
(reasoning; scheduled every 5 minutes: moves attempts a crash left `dispatched` to `unknown`) and
`feedback.purge-reports` (feedback; scheduled daily at 03:17 UTC: deletes reports about deleted accounts 90 days after the
deletion), `supply.answer-quick-answer` (supply; writes one Quick answer, D-253) and `supply.purge-quick-answers` (supply;
scheduled every ten minutes: deletes the Quick answers whose day is over, D-255) and
`geography.sweep-quiet` (geography; scheduled every 15 minutes: hands each universe with a place due to go quiet to
`geography.settle-quiet`, one universe per job, rules only, no model; D-104). A job
that calls the reasoning harness declares `expireInSeconds` above what one delivery can take (see
`reasoning/README.md`). Consumers are non-transactional: a
handler opens its own short transactions, records its applied identity with its effects so a
redelivery is harmless, and never holds a transaction across a network call. Queue delivery is not
permission to repeat a paid call: paid work consults the attempt ledger (`reasoning/`).

`planner.run` (#236) is an IDs-only personal role wake-up:1200s expiry, three 30s-backoff retries,
local concurrency 1. Both shipped request compositions enqueue transactionally after material
Evidence/PC change. Worker execution defaults disabled; see `modules/planner/README.md` for
coalescing, claim/attempt fences, explicit resume and erasure.

The optional fourth `EnqueueJob` argument `{startAfter: Date}` schedules within the same transaction.
Dates must be finite and no more than 24h ahead; pg-boss accepts Date and converts it to ISO itself.
Planner uses this only for a same-business-run wake at claim expiry, carrying an expected claim ID.
It is durable pg-boss work, not a timer or a second outbox. Existing three-argument calls are unchanged.

The fourth argument also accepts an independently optional `jobId`, a canonical lowercase UUID
chosen by the server before enqueue. It is sent as pg-boss's actual job ID; a missing creation
or a different returned ID throws in the caller's transaction. Explicit undefined, accessor or
unknown option fields refuse rather than silently dropping a wake fence. `startAfter` retains
its finite Date/24-hour bound; three-argument calls retain their behavior.

Personal role normal/retirement wake markers use this exact ID. Their owning adapters may seek
one `(queue name, id)` primary key and verify its closed scope/run/generation metadata before
recovering a terminal or missing delivery. A live delivery or unproved match stays busy/refused;
no JSON job-history scan, new queue, second outbox or paid permission is introduced. Replacement
still needs the role's current authority, original generation, no live claim and real source or
explicit eligible resume; it preserves the business run and attempt ledger. Actual queue-ID,
expiry, stale-delivery, unknown-accounting and rollback fixtures run in hosted Actions.
