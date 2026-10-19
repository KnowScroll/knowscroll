# infrastructure/jobs

pg-boss is the only work outbox (blueprint §19). Owns: the `pgboss` schema.

| Operation | Purpose |
|---|---|
| `defineQueue({...})` | Declares a queue `<module>.<operation>`: versioned ID-only payload schema, delivery policy (expiry, retries, backoff, retention, dead letter) and consumer policy (concurrency, polling). |
| `createBoss(settings, role)` | `install` (migrate command: creates/upgrades the schema), `producer` (API: sends only, no maintenance), `consumer` (worker: claims work and runs maintenance; never changes the schema). pg-boss keeps its own small pool. |
| `applyQueueDeclarations(boss, queues)` | Creates each queue and its `<name>.dead` queue, or brings an existing queue's policy in line. Idempotent; run by `dist/migrate.js`. |
| `makeEnqueueJob(boss)` → `enqueue(scope, queue, payload)` | The job port. Requires the open `PersonalScopeTx`; validates the payload; `boss.send(name, data, { db: fromKysely(trx) })` writes the job through the scope's own transaction, so a rollback removes the job with the state change. |
| `startConsumers(boss, consumers, logEvent)` | Registers the worker's explicit consumer registry and settles each job explicitly (`perJobResults`): success → completed; a payload that does not match its queue → dead-lettered at once (no retries); a handler failure → failed with a code-only output (`{failure, errorClass, code}`), retried or dead-lettered by the queue's policy. pg-boss never stores an error message, stack or driver detail. Failures are logged once (sanitised, no payload). |
| `drainConsumers(boss, count, timeoutMs, logEvent)` | Stops claiming, waits for running handlers (bounded), closes pg-boss. |
| `deleteJobPayloads(scope, queues)` | Erasure: deletes one universe's queued, active, retained and dead-lettered payloads from the named queues. |

Declared queues: `evidence.apply-action` (evidence module). Consumers are non-transactional: a
handler opens its own short transactions, records its applied identity with its effects so a
redelivery is harmless, and never holds a transaction across a network call. Queue delivery is not
permission to repeat a paid call: paid work consults the attempt ledger (`reasoning/`).
