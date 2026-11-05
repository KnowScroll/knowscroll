# Integration and installed-release tests

These tests check how real modules work together against disposable PostgreSQL. For example,
[account deletion](modules/account-deletion.test.ts) fills registered stores, starts deletion and
checks erasure and retry behavior. [The HTTP journey](release/account-http.test.ts) drives the
installed API and worker so source-level dependency injection alone cannot pass it.

## Choose the test layer

| Command from the root | What it exercises | Required setup |
| --- | --- | --- |
| `pnpm --filter @knowscroll/integration-tests test` | Module/infrastructure integration and role-evaluation projects | `KS_TEST_DATABASE_URL` for a disposable PostgreSQL server; a role that can create databases |
| `pnpm --filter @knowscroll/integration-tests exec vitest run --project integration modules/account-deletion.test.ts` | One module journey using the same setup | The same disposable server, not an owner's database |
| `pnpm --filter @knowscroll/integration-tests test:evaluation` | Synthetic role contexts through the fixture reasoning harness | The same server; no real provider key or content-quality claim |
| `pnpm --filter @knowscroll/integration-tests test:release` | Deployed `pnpm deploy` trees, migrations, HTTP and worker lifecycle | `KS_RELEASE_DIR` plus the disposable server; see the hosted `build` job |

The [hosted checks workflow](../../.github/workflows/checks.yml) supplies PostgreSQL, media tools,
built packages and release trees. D-010 allocates these database/release suites to hosted Actions.
The commands above are for selecting and understanding those jobs, not instructions to point
them at dev, the owner's databases or the shared Reel pool.

## How isolation works

[support/global-setup.ts](support/global-setup.ts) builds a template with all registered migrations,
the pg-boss schema and fixture queues. Each ordinary test file calls `createTestDatabase()` to clone
it, then drops its clone. Helpers create/drop only names with the `ks_it_*` prefix; the PostgreSQL
service itself must still be disposable. Release fixtures start the deployed trees against empty
fixture databases and stop only the processes they started.

[support/queues.ts](support/queues.ts) labels fixture queues. Seeded records and fake providers are
also fixtures. They must not become product data, observed user activity or provider evidence.
A passed fixture is evidence for its asserted behavior, not deployment, real model quality,
physical-device parity or a successful live privacy journey.

## Failures and recovery

Read the failing assertion and its owning module README before changing a fixture. Do not weaken
a privacy, lock, retry or accounting assertion to make a cleanup pass. A setup failure means the
journey did not run; record it separately from a behavioral failure. Preserve command IDs and
original recording generations when exercising retries. Unknown paid outcomes remain liabilities;
fixture recovery must never teach production code to resend them.

The [boundary probes](boundaries/) check import, manifest, transaction and network restrictions
without a database. Run them through the root `boundaries:probe`, `boundaries:manifests`,
`lint:probe` and `lint:probe:network` commands.
