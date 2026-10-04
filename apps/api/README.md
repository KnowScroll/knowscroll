# @knowscroll/api

The HTTP adapter, a Fastify server for the mobile and desktop clients. Each route authenticates the
bearer token (or the checked web-session cookie), parses strict input with a `@knowscroll/contracts`
schema, calls a `@knowscroll/db` function inside the authenticated transaction, and replies. It
makes no model or Cutroom call and contains no SQL.

## Entry points

- `src/main.ts`: the process (`pnpm dev:api`). Listens on 127.0.0.1, refuses to run under
  `NODE_ENV=production`, closes the server and then the pool on SIGINT/SIGTERM.
- `src/app.ts`: `buildApp`, which registers the routes and owns the global error handler.
- `src/routes/`: one file per area (`feed.ts`, `encounters.ts`, `asks.ts`, `answers.ts`, `atlas.ts`,
  `inquiries.ts`, `privacy.ts`, `session.ts`, `sign-in.ts`, ...).
- `src/http/`: `authenticated.ts`, `errors.ts`, `input.ts`, `web-session.ts`.
- `src/mail/` (magic-link senders) and `src/media/stream.ts` (media serving).

## Rules a contributor must not break

- No SQL: `pnpm lint` runs `scripts/check-architecture.mjs`, which fails on `.query(` under `apps/`.
  Add or extend a function in `packages/db` instead
  ([ADR-0048](../../docs/decisions/0048-backend-module-boundaries.md)).
- Imports no provider SDK and no worker file; relative specifiers never leave the app.
- Errors are mapped in one place, the global handler in `src/app.ts` (see `src/http/errors.ts`),
  plus the two `kind` mappers beside their routes (`ExplicitAskError` in `src/routes/asks.ts`,
  `TraceRevisitError` in `src/routes/universe.ts`).
  Only 4xx and 503 keep their message; other failures answer 500 without detail.
- Authenticate and lock on the same transaction, require the expected epoch before replay, and
  reject an idempotency key reused with different content ([AGENTS.md](AGENTS.md);
  ADR-0009, ADR-0016).
- Selection is not exposure; event and job admission is one SQL transaction.
- Mobile-facing JSON is a contract: read
  [docs/contracts/bootstrap-http.md](../../docs/contracts/bootstrap-http.md) before changing it.
- Nothing imports this app except the repo-level `tests/` and `scripts/`, by relative path.
  Conventions: "Code conventions" in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Where to start reading

1. [AGENTS.md](AGENTS.md).
2. `src/main.ts`, then `src/app.ts`: startup, hooks, route registration, the error handler.
3. `src/http/authenticated.ts` and `src/http/errors.ts`: the one authentication path and the error contract.
4. `src/routes/feed.ts`: a representative route.
5. `src/routes/encounters.ts`: idempotent event recording.

Dependency graph: [docs/architecture/module-map.md](../../docs/architecture/module-map.md).
Moved files: [docs/architecture/moved-paths.md](../../docs/architecture/moved-paths.md).
