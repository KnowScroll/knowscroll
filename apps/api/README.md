# @knowscroll/api

The HTTP and live-hint API: Nest 12 with the Express adapter, oRPC contract handlers
(`@orpc/nest`), RFC 9457 problem details, and a Socket.IO gateway for revision hints. Entry
points: `dist/main.js` (serve), `dist/migrate.js` (migrate the database, install pg-boss, apply
queue policies) and `dist/operator.js issue-sign-in --email <address>` (dev/stage only: a one-time
sign-in link for a disposable test account, D-007). Variables:
`docs/v2/engineering/runtime-configuration.md`.

| File | Role |
|---|---|
| `src/main.ts` | Validate config → pool → pg-boss (producer) → Nest from the composition root → LISTEN relay → listen; stop in reverse |
| `src/app.module.ts` | Composition root: binds every token (database, `withPersonalScope`, job port, callers) and lists controllers and the gateway |
| `src/routes.ts` | Explicit route index (every controller) |
| `src/http/*.controller.ts` | Thin handlers: caller → use case → typed outcome → response or problem |
| `src/http/callers.ts` | The AuthenticatedCaller port (`resolve` from the request's or handshake's headers, and `sessionValid` for long-lived sockets) and its production adapter over identity's sessions (D-022): authority = account + universe + current epoch, re-read on every request; a web session only as its cookie, a native one only as a bearer token; revoked/expired → nothing (401). The CI-only `test-bearer` adapter (sessions always valid) is refused unless `NODE_ENV=test` in a `ci` or `local` world |
| `src/http/auth.controller.ts` | `/auth/sign-in` (202 for every well-formed address), `/auth/redeem` (web: sets the HttpOnly SameSite=Lax session cookie, origin required; native: the bearer token once; a session the device still presents is revoked: account switch), `/auth/session`, `/auth/sign-out` (revokes and drops the account's sockets, clears the cookie) |
| `src/http/auth-credentials.ts` | Credentials from headers (bearer wins over the cookie), the session cookie's attributes, `originGuard` (cookie-authenticated POST/PUT/PATCH/DELETE must carry `Origin: KS_PUBLIC_ORIGIN`; any foreign `Origin` is refused, 403 `ORIGIN_NOT_ALLOWED`), `noStoreForAuth`, the client address behind Caddy |
| `src/http/auth-rate-limit.ts` | In-process limits of the sign-in routes per client address and per process (the per-address link limit is identity's, in the database) |
| `src/http/problems.ts` | The one outcome → HTTP mapping: oRPC errors, Nest exceptions and body-parser errors become `application/problem+json`; lock waits, timeouts, deadlocks and serialisation failures become a 503 with `Retry-After`, logged once as `http.retryable_failure` with their code; unexpected errors are logged once and answered with `INTERNAL` |
| `src/http/request-context.ts` | Server-generated request ID (`x-request-id`) and `http.request_completed` with the route template |
| `src/realtime/scope.gateway.ts` | Socket.IO on `/socket.io`: authenticated connections (native: the bearer token in `auth.token`; web: the session cookie, only from `KS_PUBLIC_ORIGIN`); `subscribe_scope` joins first, then checks session validity and current access and leaves when refused (error ack on failure); every relayed hint re-authorised per socket (session and access, cache ≤ 30 s): `scope_revoked` for a dropped subscription, a disconnect for an invalid session; `revokeAccountSockets` notices disconnect an account's sockets; after a relay reconnect every socket is closed and must authenticate again; no socket commands |
| `src/modules/*.ts` | Feature wiring: identity (read ports, sign-in use cases and the mail sender chosen by configuration, the operator use case), content and experience providers bound to this app's tokens |
| `src/queues.ts` | The backend's `releaseQueues` (applied by `migrate.js`) |
| `src/migrate.ts` | Migration command |
| `src/operator.ts` | Operator sign-in command (refused in live and without `KS_ALLOW_OPERATOR_SIGN_IN=1`; link on stdout, diagnostics on stderr) |

Routes: `GET /health` (release identity and relay state), `POST /auth/sign-in`, `POST /auth/redeem`,
`GET /auth/session`, `POST /auth/sign-out`, `POST /v1/actions`, `GET /v1/saved`. Request pipeline:
request context → `Cache-Control: no-store` under `/auth` → origin guard (403) → JSON-only bodies
(415 otherwise) → size-limited JSON parser (413) → body error handler → Nest routes → oRPC handler
→ problem encoder.
