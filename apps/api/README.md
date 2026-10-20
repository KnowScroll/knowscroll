# @knowscroll/api

The HTTP and live-hint API: Nest 12 with the Express adapter, oRPC contract handlers
(`@orpc/nest`), RFC 9457 problem details, and a Socket.IO gateway for revision hints. Entry
points: `dist/main.js` (serve), `dist/migrate.js` (migrate the database, install pg-boss, apply
queue policies) and `dist/operator.js` (dev/stage/ci/local only: `issue-sign-in --email <address>` prints a one-time
sign-in link for a disposable test account, D-007; `content import-editorial --file <path>` admits the authored starter Scroll, D-005). Variables:
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
| `src/http/supply.controller.ts` | Scoped create/read/cancel adapters: immutable command receipts, current private request status and exhaustive sanitised refusal mapping |
| `src/http/geography.controller.ts` | Current own-world snapshot/catch-up reads; admitted caller authority only, no Cartographer request or transition acknowledgement |
| `src/http/observations.controller.ts` | `POST /v1/observations/batch` (stored, not projected) and the dev-only evidence diagnostics read (world allow-list; 404 elsewhere) |
| `src/modules/*.ts` | Feature wiring: identity (read ports, sign-in use cases and the mail sender chosen by configuration, the operator use case), content (read ports, the document renderer, the import use case), experience and evidence (intake) providers bound to this app's tokens |
| `src/queues.ts` | The backend's `releaseQueues` (applied by `migrate.js`) |
| `src/migrate.ts` | Migration command |
| `src/operator.ts` | Operator commands: `issue-sign-in` (refused in live and without `KS_ALLOW_OPERATOR_SIGN_IN=1`; link on stdout, diagnostics on stderr) and `content import-editorial --file <path>` (allow-listed worlds only; one JSON line on stdout, a `content.scroll_admitted` record and, for a refusal, its stage and issue codes and paths on stderr; exit 0 admitted or unchanged, 1 refused or failed, 2 usage) |

Routes: `GET /health` (release identity and relay state), `POST /auth/sign-in`, `POST /auth/redeem`,
`GET /auth/session`, `POST /auth/sign-out`, `POST /v1/actions`, `GET /v1/saved`, `POST /v1/experience/open`,
`POST /v1/experience/activate`, `POST /v1/experience/navigate`, `GET /v1/experience/exposures/{id}/document`, `POST /v1/observations/batch`
`POST /v1/content/requests`, `GET /v1/content/requests/{requestId}`, `POST /v1/content/requests/cancel`
and the dev-only `GET /v1/diagnostics/exposures/{id}/evidence` (404 outside `dev`, `stage`, `ci`, `local`). Request pipeline:
request context → `Cache-Control: no-store` under `/auth` → origin guard (403) → JSON-only bodies
(415 otherwise) → size-limited JSON parser (413) → body error handler → session/scope guard → Nest routes → oRPC handler
→ problem encoder.

## Media access (S2.4)

Optional `KS_MEDIA_ROOT` enables local media delivery. The API never reads Cutroom settings/calls it.
`POST /v1/media/grants` is protected by the unchanged session + X-KS-Scope guard. For an existing Reel
exposure, it returns the consumer document and a 60s HMAC grant. `/media/:digest?grant=…` has a separate
reviewed session/grant boundary: every GET/HEAD re-resolves the live session, checks the exact grant
session/account/universe/epoch/audience/expiry/digest and the caller-owned admitted revision. Unknown,
foreign, withdrawn, stale or missing media all return404. No broad `/v1` scope exemption was added.

Signing keys are random per API start; this design assumes one API instance/world. Restart invalidates
grants; the player's renewal/Retry recovers without creating an exposure. Grant URLs are credentials:
keep them in memory, never logs/evidence, never a public share. Responses use private/no-store caching,
no-referrer and SHA-256 ETags. Single ranges (including suffixes),206/416, If-None-Match/304, If-Range,
HEAD and Accept-Ranges are supported; multiple ranges are refused416. Caddy must not compress media.
Logs use route templates and stable refusals only. Already-buffered client bytes cannot be recalled;
AccountScope synchronously pauses/clears playback on logout/account switch/privacy reset.

Explore discovery, exact return, navigation and offer activation dispatch to the Composer/Experience
consumers; current exposure context and Like/Unlike/Hide/Save/Unsave dispatch to their scoped
Experience consumers. Direct open/activate remains available. These are source capabilities;
fixture or release checks do not establish a live reading journey.

Supply's `POST /v1/content/requests`, `GET /v1/content/requests/{requestId}` and
`POST /v1/content/requests/cancel` are thin adapters to Supply's create/read/cancel ports. They use
the same origin, session, scope and JSON middleware as every account route. Create and cancel
return their immutable command receipts; GET returns current status and schedules no work or
retry. A ready result identifies available content without activating it. Unknown and foreign
requests both answer `NOT_FOUND`; refusals disclose no private request body or backend detail.
These routes do not authorize production or wait for a provider.

Geography's read-only `POST /v1/universe/geography/read` and
`POST /v1/universe/geography/deltas/read` use the existing strict bounded snapshot/cursor and
contiguous delta contracts. POST preserves their nested JSON bodies and retains the same origin,
session, scope and JSON guards. The backend derives the current own universe/epoch from the admitted
caller, validates selection/cursors and returns independent personal/geography/component revisions.
Foreign and unknown system selections both answer `NOT_FOUND`; mixed or expired cursors disclose
no foreign world. Empty/loading/lagging/unavailable and `snapshot_required` are explicit backend
states. Reads schedule no work, create no state row, acknowledge no presentation and grant no
formation, scene, provider or sharing authority. Scene projection and its consumer remain separate.
Installed-release HTTP fixtures exercise the real Nest/PG boundary without a worker or provider;
they are not deployed map or formation evidence.
