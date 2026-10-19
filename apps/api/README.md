# @knowscroll/api

The HTTP and live-hint API: Nest 12 with the Express adapter, oRPC contract handlers
(`@orpc/nest`), RFC 9457 problem details, and a Socket.IO gateway for revision hints. Entry
points: `dist/main.js` (serve) and `dist/migrate.js` (migrate the database, install pg-boss, apply
queue policies). Variables: `docs/v2/engineering/runtime-configuration.md`.

| File | Role |
|---|---|
| `src/main.ts` | Validate config → pool → pg-boss (producer) → Nest from the composition root → LISTEN relay → listen; stop in reverse |
| `src/app.module.ts` | Composition root: binds every token (database, `withPersonalScope`, job port, callers) and lists controllers and the gateway |
| `src/routes.ts` | Explicit route index (every controller) |
| `src/http/*.controller.ts` | Thin handlers: caller → use case → typed outcome → response or problem |
| `src/http/callers.ts` | The AuthenticatedCaller port (`resolve`, and `sessionValid` for long-lived sockets; S1.3 plugs in real sessions); `none` (default) and the CI-only `test-bearer` adapter (sessions always valid), refused unless `NODE_ENV=test` in a `ci` or `local` world |
| `src/http/problems.ts` | The one outcome → HTTP mapping: oRPC errors, Nest exceptions and body-parser errors become `application/problem+json`; lock waits, timeouts, deadlocks and serialisation failures become a 503 with `Retry-After`, logged once as `http.retryable_failure` with their code; unexpected errors are logged once and answered with `INTERNAL` |
| `src/http/request-context.ts` | Server-generated request ID (`x-request-id`) and `http.request_completed` with the route template |
| `src/realtime/scope.gateway.ts` | Socket.IO on `/socket.io`: authenticated connections; `subscribe_scope` joins first, then checks session validity and current access and leaves when refused (error ack on failure); every relayed hint re-authorised per socket (session and access, cache ≤ 30 s): `scope_revoked` for a dropped subscription, a disconnect for an invalid session; `revokeAccountSockets` notices disconnect an account's sockets; after a relay reconnect every socket is closed and must authenticate again; no socket commands |
| `src/modules/*.ts` | Feature wiring: identity, content and experience providers bound to this app's tokens |
| `src/queues.ts` | The backend's `releaseQueues` (applied by `migrate.js`) |
| `src/migrate.ts` | Migration command |

Routes: `GET /health` (release identity and relay state), `POST /v1/actions`, `GET /v1/saved`. Request pipeline: request context →
JSON-only bodies (415 otherwise) → size-limited JSON parser (413) → body error handler → Nest
routes → oRPC handler → problem encoder.
