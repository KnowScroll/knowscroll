# @knowscroll/api

The HTTP API: Nest 12 with the Express adapter, oRPC contract handlers (`@orpc/nest`) and RFC 9457
problem details. Entry points: `dist/main.js` (serve) and `dist/migrate.js` (migrate the database,
install pg-boss, apply queue policies). Variables: `docs/v2/engineering/runtime-configuration.md`.

| File | Role |
|---|---|
| `src/main.ts` | Validate config → open the database → build Nest from the composition root → listen; stop in reverse |
| `src/app.module.ts` | Composition root: binds tokens to adapters, lists controllers |
| `src/routes.ts` | Explicit route index (every controller) |
| `src/http/*.controller.ts` | One controller per contract area; each method implements a route of `apiContract` |
| `src/http/problems.ts` | The one outcome → HTTP mapping: oRPC errors, Nest exceptions and body-parser errors become `application/problem+json`; unexpected errors are logged once and answered with `INTERNAL` |
| `src/http/request-context.ts` | Server-generated request ID (`x-request-id`) and `http.request_completed` with the route template |
| `src/queues.ts` | Every queue the release declares (applied by `migrate.js`) |
| `src/migrate.ts` | Migration command |

Request pipeline: request context → JSON-only bodies (415 otherwise) → size-limited JSON parser
(413) → body error handler → Nest routes → oRPC handler → problem encoder.
