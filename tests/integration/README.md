# @knowscroll/integration-tests

Real-PostgreSQL tests, run in GitHub Actions only (D-010).

- `pnpm test` (CI `backend` job): `support/global-setup.ts` builds one template database with
  every registered migration, pg-boss's schema and the fixture queues; each test file clones it
  with `createTestDatabase()` and drops it afterwards. Needs `KS_TEST_DATABASE_URL`, a role that
  can create databases on a disposable server; only databases named `ks_it_*` are created or
  dropped.
- `pnpm test:release` (CI `build` job): starts the deployed release trees named by
  `KS_RELEASE_DIR` (`pnpm deploy` output) as the VPS runs them, against an empty database.

Fixtures are labelled: queues under `support/queues.ts` and any seeded rows say they are CI
fixtures. No test touches an owner database.
