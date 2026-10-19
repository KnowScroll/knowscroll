# Backend foundation (S1.2)

How a personal command travels through the v2 backend, which code owns each step, and where it is
tested. Architecture: blueprint §4, §5, §19, §22, §23, §26. Folder READMEs hold the details.

## The spike journey

```text
POST /v1/actions {commandId, kind: save|unsave, target: {assetId, assetRevision}}
  apps/api  ExperienceController (oRPC @Implement)  → caller from the AuthenticatedCaller port
  experience.applyAction (application, framework-free)
    withPersonalScope: BEGIN; SELECT identity.universes … FOR NO KEY UPDATE; recheck status/epoch/owner
      receipts: lookup (replay | COMMAND_KEY_REUSED) → content: asset admitted at revision
      receipts: insert pending → experience.saved_items / experience.actions
      jobs: enqueue evidence.apply-action  (boss.send … { db: fromKysely(trx) })
      identity.universes.revision += 1; pg_notify (the command's own watermark)
      receipts: store outcome
    COMMIT  (receipt + effects + job, or nothing)
  ← 200 {…, revision, replayed}
apps/worker  evidence.apply-action consumer (non-transactional)
  evidence.applyActionEvidence: withPersonalScope(system actor, payload epoch)
    insert evidence.action_events (unique per action) → advance universe revision again → pg_notify
  COMMIT
apps/api  ScopeNoticeRelay (LISTEN, own connection, reconnects for as long as needed)
  → ScopeGateway → each socket in room scope:universe:<id>, re-authorised (≤ 30 s cache)
  → Socket.IO scope_changed {scope, revision, eventId}   (or scope_revoked, and leave the room)
client  GET /v1/saved → {revision, items}
```

## Where each guarantee is tested (CI, real PostgreSQL 16)

| Guarantee | Test |
|---|---|
| Duplicate command returns the stored outcome; no second effect, job or hint | `tests/integration/modules/apply-action.test.ts`, `release/spike-journey.test.ts` |
| Same key, different request → `COMMAND_KEY_REUSED` (422 problem) | `modules/apply-action.test.ts`, `infrastructure/receipts.test.ts`, `release/spike-journey.test.ts` |
| Second connection waits for the universe lock, then sees the new epoch/revision | `infrastructure/personal-scope.test.ts` |
| Rollback removes the enqueued job (and receipt and effects) | `modules/apply-action.test.ts` |
| Relay restart → re-LISTEN → resync, then hints flow again; also through an outage in which the database refuses all connections | `infrastructure/notices.test.ts` |
| Subscriptions are revoked: re-authorisation on relay, account revocation notice | `release/spike-journey.test.ts` |
| Concurrent identical commands apply once | `modules/apply-action.test.ts` |
| Concurrent deliveries send a model step once; a late answer after `unknown` is `reconciled`; authority lost mid-call → outcome recorded, output withheld | `modules/reasoning-attempts.test.ts` |
| Failed jobs store code-only outputs; invalid payloads dead-letter at once | `modules/apply-action-evidence.test.ts` |
| Release trees install exactly the lockfile's versions | `release/lockfile.test.ts` |
| Worker crash after commit + pg-boss redelivery → one evidence row, one revision | `modules/apply-action-evidence.test.ts` |
| Crash after dispatch leaves `unknown`; redelivery never re-sends | `modules/reasoning-attempts.test.ts` |
| No network call inside a transaction | `infrastructure/transaction-guard.test.ts` |
| Every `universe_id` table and account-linked column is declared, with RESTRICT references; every queue carrying `universeId` has an eraser; erasers clear one universe only and keep open attempt liability | `infrastructure/erasure.test.ts` |
| Secrets never reach logs | `packages/backend/src/infrastructure/observability/canary.test.ts`, `release/spike-journey.test.ts` |
| Production build boots, serves `/health`, refuses the test caller adapter | `release/boot.test.ts`, `release/spike-journey.test.ts` |
| Generated Kysely types match the migrated schema | `checks.yml` build job (`kysely-codegen --verify`) |

## Rules the code enforces

- Personal writes need a `PersonalScopeTx`, which only `withPersonalScope` creates and which dies
  with its transaction. Workers recheck authority themselves under the same lock.
- Receipt, effects, the revision watermark and required pg-boss work commit together;
  NOTIFY/Socket.IO hints are disposable and carry no private content.
- Every transaction is opened by `infrastructure/postgres` (ESLint), so the network guard sees it;
  shared roots are locked only after the personal root (`enterSharedRoot`).
- Model/provider/media adapters refuse to run inside a transaction; the attempt ledger decides
  whether anything may be sent, and settles outcomes without depending on current authority.
- One `logEvent` catalogue, no free text in logs, personal-linkable IDs withheld from the journal.
- One outcome → HTTP mapping (`apps/api/src/http/problems.ts`): typed refusals become RFC 9457
  problems with stable codes; anything else is logged once and answered as `INTERNAL`.
- Import boundaries (dependency-cruiser): `application/` has no Nest, Kysely, pg, pg-boss or
  adapters; modules meet through `public.ts`; only composition roots import `nest-providers`.

## Running it by hand

Automated suites run in CI only. To use the API locally, build (`pnpm --filter
'!@knowscroll/client' --filter '!@knowscroll/integration-tests' build`), run `node
apps/api/dist/migrate.js` against a disposable database, insert fixture rows, then start
`apps/api/dist/main.js` with `NODE_ENV=test KS_AUTH_ADAPTER=test-bearer` and
`apps/worker/dist/main.js` (variables: `runtime-configuration.md`). Never point it at an owner
database.
