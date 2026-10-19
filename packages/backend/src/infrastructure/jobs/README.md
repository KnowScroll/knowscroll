# infrastructure/jobs

pg-boss is the only work outbox (blueprint §19). Owns: the `pgboss` schema.

| Operation | Purpose |
|---|---|
| `defineQueue({...})` | Declares a queue `<module>.<operation>`: versioned ID-only payload schema, delivery policy (expiry, retries, backoff, retention, dead letter) and consumer policy (concurrency, polling). |
| `createBoss(settings, role)` | `install` (migrate command: creates/upgrades the schema), `producer` (API: sends only, no maintenance), `consumer` (worker: claims work and runs maintenance; never changes the schema). pg-boss keeps its own small pool. |
| `applyQueueDeclarations(boss, queues)` | Creates each queue and its `<name>.dead` queue, or brings an existing queue's policy in line. Idempotent; run by `dist/migrate.js`. |
| `startConsumers(boss, consumers, logEvent)` | Registers the worker's explicit consumer registry. Payloads are validated against the queue schema; a failure is logged once (sanitised, no payload) and rethrown so pg-boss retries or dead-letters. |
| `drainConsumers(boss, count, timeoutMs, logEvent)` | Stops claiming, waits for running handlers (bounded), closes pg-boss. |

Consumers are non-transactional: a handler opens its own short transactions, records its applied
identity with its effects, and never holds a transaction across a network call. Queue delivery is
not permission to repeat a paid call: paid work consults the attempt ledger (`reasoning/`).
