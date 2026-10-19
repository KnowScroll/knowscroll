# @knowscroll/api

The HTTP and live-hint API: Nest 12 with the Express adapter, oRPC contract handlers
(`@orpc/nest`), RFC 9457 problem details, and a Socket.IO gateway for revision hints. Entry
points: `dist/main.js` (serve) and `dist/migrate.js` (migrate the database, install pg-boss, apply
queue policies). Variables: `docs/v2/engineering/runtime-configuration.md`.

| File | Role |
|---|---|
| `src/main.ts` | Validate config → pool → pg-boss (producer) → Nest from the composition root → LISTEN relay → listen; stop in reverse |
| `src/app.module.ts` | Composition root: binds every token (database, `withPersonalScope`, job port, callers) and lists controllers and the gateway |
| `src/modules/*.ts` | Feature wiring: which backend providers implement a module's ports |
| `src/routes.ts` | Explicit route index (every controller) |
| `src/http/*.controller.ts` | Thin handlers: caller → use case → typed outcome → response or problem |
| `src/http/callers.ts` | The AuthenticatedCaller port; `none` (default) and the CI-only `test-bearer` adapter, refused unless `NODE_ENV=test` |
| `src/http/problems.ts` | The one outcome → HTTP mapping: oRPC errors, Nest exceptions and body-parser errors become `application/problem+json`; lock timeouts become 503; unexpected errors are logged once and answered with `INTERNAL` |
| `src/http/request-context.ts` | Server-generated request ID (`x-request-id`) and `http.request_completed` with the route template |
| `src/realtime/scope.gateway.ts` | Socket.IO on `/socket.io`: authenticated connections, `subscribe_scope` authorised against current access on every call, `scope_changed`/`scope_resync` hints from the relay; no socket commands |
| `src/queues.ts` | Every queue the release declares (applied by `migrate.js`) |
| `src/migrate.ts` | Migration command |

Routes: `GET /health`, `POST /v1/actions`, `GET /v1/saved`. Request pipeline: request context →
JSON-only bodies (415 otherwise) → size-limited JSON parser (413) → body error handler → Nest
routes → oRPC handler → problem encoder.
