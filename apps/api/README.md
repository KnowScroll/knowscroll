# @knowscroll/api

## Clear exploration

Related: #345.

`POST /v1/privacy/clear-exploration` accepts the Identity-owned durable operation (202);
`POST /v1/privacy/clear-exploration/status` reads its coarse current status. Both use the
ordinary Origin/session/current `X-KS-Scope` pipeline, including during the operation's
barrier, and set private/no-store before body parsing or authentication. Their closed
privacy problem family masks unknown keys, values and numeric issue paths. Historical
acceptance epochs never identify the current authorized scope.

The API only calls start/status. It does not erase data or wait for the worker in an HTTP
request. Start commits the epoch/barrier, lifetime receipt and required fixed pg-boss job
together; the separately registered normal worker performs selective removal and exact-set
accounting. Composition depends on the reviewed durable core in PR #348. Source and installed
Actions fixtures are separate from actual dev/stage privacy acceptance.

## Operator routes (D-044)

Related: #248.

`OperatorController` serves `GET /v1/operator/panels` (the six panels of the Operator screen) and
`GET /v1/operator/journeys/{id}` (one record's timeline). They take the ordinary session and scope pipeline, then
check on every call that the signed-in account is an operator of the world (`KS_OPERATOR_ACCOUNTS`, read from the
account's address now). Anyone else gets the same 404 as an unknown route, and the refusal is logged as a code
(`operator.refused`). The routes read the allowlisted `ops` views and change nothing. Module:
`packages/backend/src/modules/operator/README.md`.

## Account: sessions, export and deletion (D-043)

Related: #246.

`AccountController` serves `GET /v1/account/sessions`, `POST /v1/account/sessions/end` and `.../end-others`
(signing out another device; the presented session is refused with 409), `POST /v1/account/exports`,
`GET /v1/account/exports`, `POST /v1/account/exports/link`, and `POST /v1/account/delete`. All take the
ordinary session/scope pipeline. Deletion checks the epoch the person saw, accepts a durable operation (202)
and clears the web cookie with the answer; the API never erases anything or waits for the worker. The two
receipt routes `GET /auth/deletion/{receiptId}` and `POST /auth/deletion/retry`, and the download
`GET /auth/exports/{token}` (`ExportDownloadController`), take no session: deletion ends every session and the
receipt must still be readable, and a download link is the credential (one minute, one use, never cached).
They share a per-client limiter of 120 requests per 15 minutes (`receiptPerClient`; in memory, a flood brake).
Redeeming a sign-in link now stores the coarse device label computed from the `User-Agent`
(`deviceLabelOf`). Verified by `tests/integration/release/account-http.test.ts` against the installed API
and worker.

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
| `src/http/visibility.controller.ts` | `GET/POST /v1/social/visibility`, `GET/POST /v1/social/presence/preference` and `POST /v1/social/visits/read` over `VISIBILITY_USE_CASES`: private/no-store, every answer parsed again and bound to the caller's account and epoch (and a visit answer to the person asked for). A refused visit is the one `unavailable` snapshot, never a problem that says why (D-047) |
| `src/realtime/scope.gateway.ts` | Socket.IO on `/socket.io`: authenticated connections (native: the bearer token in `auth.token`; web: the session cookie, only from `KS_PUBLIC_ORIGIN`); `subscribe_scope` joins first, then checks session validity and current access and leaves when refused (error ack on failure); every relayed hint re-authorised per socket (session and access, cache ≤ 30 s): `scope_revoked` for a dropped subscription, a disconnect for an invalid session; `revokeAccountSockets` notices disconnect an account's sockets; after a relay reconnect every socket is closed and must authenticate again; the one thing a client says over a socket is `presence_heartbeat`, answered `{ ok: true }` whether or not availability is shared, stored only for a person who chose to show it, and ignored when it follows the last by less than 10 s on one socket; no other socket commands |
| `src/http/supply.controller.ts` | Scoped create/read/cancel adapters: immutable command receipts, current private request status and exhaustive sanitised refusal mapping |
| `src/http/geography.controller.ts` | Current own-world snapshot/catch-up reads; admitted caller authority only, no Cartographer request or transition acknowledgement |
| `src/http/observations.controller.ts` | Legacy `POST /v1/observations/batch` and versioned `POST /v1/observations/recording-batch` (stored, not projected), plus the dev-only evidence diagnostics read (world allow-list; 404 elsewhere) |
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

The strict `observation-batch.v2` intake mounts the shared recording contract at
`POST /v1/observations/recording-batch`. It passes the original generation and events to
Evidence under the guard-admitted authority and returns the initiating account/epoch,
submitted generation and independently current generation. A processed answer correlates
ordered event IDs and exact counts. A paused/stale answer is final `not_recorded`, with no
ingestion log or successful storage claim; an unknown response is retried with the same
body. The legacy route maps `recording_required` to the existing fixed 409 and never
converts a paused batch into a successful acknowledgement. Malformed or uncorrelated
backend output fails closed before success logging. These adapters and authored controller
fixtures establish source behavior only; complete production wiring, Actions and real
recording journeys remain separate gates.

## Recording control

Related: #381.

`POST /v1/privacy/recording/read` and `POST /v1/privacy/recording/set` mount the
Identity-owned current-policy and immutable-command ports. Both use the existing
Origin/session/current-scope guard. Read replies correlate the initiating read ID,
target and account/epoch. Set replies correlate the exact original command, requested
epoch, expected generation and requested boolean; an old replay acknowledgement is
historical and never replaces an independently current policy snapshot. No provider or
worker call occurs in either handler.

These two controls and `/v1/observations/recording-batch` select a closed recording
problem family and private/no-store caching before body parsing or authentication.
Validation replies retain only fixed protocol tokens; numeric event indices, unknown
keys, received values, arbitrary extensions and another family's privileged stale
metadata are discarded. This serializer selection grants no scope exemption.

The API selects the real required Experience recording effects for direct actions,
navigation, activation and exact Keep removal. Evidence uses the real PC-owned derived
effect and forwards the same original-generation capability to both Planner and
Geography material owners. The actual lifecycle reader and owning-account barrier
remain Identity-owned. Clear's existing factory binds the sealed current-registry
eraser, while HTTP still only accepts/reads the durable operation. Complete worker
wiring, hosted positive/negative composition, client controls and deployed journeys
remain separate acceptance requirements. No source change toggles owner recording or
authorizes a paid attempt.

## Media access

Related: S2.4.

Optional `KS_MEDIA_ROOT` enables local media delivery. The API never reads Cutroom settings/calls it.
`POST /v1/media/grants` is protected by the unchanged session + X-KS-Scope guard. For an existing Reel
exposure, it returns the consumer document and a 60s HMAC grant. `/media/:digest?grant=…` has a separate
reviewed session/grant boundary: every GET/HEAD re-resolves the live session, checks the exact grant
session/account/universe/epoch/audience/expiry/digest and the caller-owned admitted revision. Unknown,
foreign, withdrawn, stale or missing media all return 404. No broad `/v1` scope exemption was added.

Signing keys are random per API start; this design assumes one API instance/world. Restart invalidates
grants; the player's renewal/Retry recovers without creating an exposure. Grant URLs are credentials:
keep them in memory, never logs/evidence, never a public share. Responses use private/no-store caching,
no-referrer and SHA-256 ETags. Single ranges (including suffixes),206/416, If-None-Match/304, If-Range,
HEAD and Accept-Ranges are supported; multiple ranges are refused 416. Caddy must not compress media.
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

Scene reads are `POST /v1/universe/scenes/manifest/read` and
`POST /v1/universe/scenes/chunks/read`. Thin Nest adapters consume the canonical 307 contracts
and existing own-scope read ports, with the same Origin/session/X-KS-Scope/JSON/size guards.
Successful Scene bodies carry `Cache-Control: private, no-store`. Only admitted caller authority
is used; foreign/unknown selection or foreign-scope references disclose only NOT_FOUND.
Current own references retain the backend's explicit stale_manifest/unknown_chunk states.
Unsupported bounded capabilities return unsupported_version; detail/motion never change identity.
Manifest and chunk revisions remain distinct, including unchanged older immutable chunks in a
newer current manifest. Reads never enqueue, bootstrap, project, acknowledge presentation or
invoke providers. Scene provider construction includes an inert projector function binding,
with no API consumer or execution path. No private payload or reference is added to diagnostics.
Installed API/PG fixtures are authored transport evidence; actual dev endpoints, formation,
rendering, camera return and durable shown/skipped acknowledgement require separate acceptance.


## Keep places

Related: #246.

`POST /v1/experience/keep/read` and `POST /v1/experience/keep/place` mount the existing
Experience Keep ports. The admitted session/scope supplies authority; strict JSON bodies carry
only the declared target or membership/CAS command. The same Origin, session, scope and body
limits apply. The thin controller validates the strict output and its initiating scope/target
binding; malformed output answers coarse INTERNAL. Reads create no state or work. Sets retain
the existing atomic receipt/place/root/hint behavior and create no Evidence, exposure or job.

Both finite POST paths, including Express case/trailing-slash forms, set
`Cache-Control: private, no-store` before guards and body parsing. Their request-context family
selects only serialization: every error uses the closed Keep problem catalogue and schema-owned
issue tokens, with unknown/numeric path segments masked and arbitrary detail/value/instance
removed. Only a validated use-case stale refusal carries currentPlaceRevision. This tag grants
no authority; generic errors and legacy routes retain their existing behavior.

Actions fixtures use installed Nest plus disposable PostgreSQL, real session/Origin/scope gates,
CAS/replay/resave and actual lock barriers. Authored ordinary Scroll, maximal valid Scroll
(eight 100×100 simulation grids) and Reel metadata fixtures record cold samples plus 20 serial
warm reads/sets after three warmups. Separate module records include actual transaction/CPU,
query spans and callback-end-to-commit-return spans. Query spans include waits; commit-return
includes driver overhead. Raw samples and runner/Node/PG/document-size/hash metadata appear in
Actions logs. These are bounded probes, not production percentiles or a client latency budget;
full canonical admission and the existing 200ms CPU admission assertion remain unchanged.
A client mount requires separate inspection and approval of actual latency records. This source
mount does not establish a deployed endpoint, device journey or selective privacy clear.
Legacy asset-keyed Unsave still has its separate ABA limitation.

### Removing a Saved item

Related: #246.

`POST /v1/experience/keep/remove` now mounts the shared `keep-remove.v1`
declaration through a dedicated controller/use-case provider. JSON names an actual
Saved UUID plus immutable asset/ref and one command ID, never an asset-only Remove,
position/CAS/force/Undo override. Existing Origin/session/AccountScope guards and
root-held Identity own-account fence apply. Current authority precedes receipts;
identical valid historical replay precedes the membership that removal deleted.
A later resave is independent: replay of A acknowledges A without deleting B;
a fresh wrong/missing membership is fixed 404 without replacement metadata.
Corrected/withdrawn saved refs can be removed without Content admission/playback.

Every successful acknowledgement is historical and position-free. The existing
Unsave action/link/state/contribution/jobs, membership/place cascade, receipt and
root watermark commit together. New effects stop at the root counter limit.
Removal has a separate closed 14-code direct RFC 9457 family with seven fixed
schema-owned/masked issue tokens, including preparse/size/media-type/Origin/auth/
scope failures. Responses are `private, no-store`; no details, received values,
current position/CAS/replacement identity or arbitrary error data are emitted.
The old Keep Read/Set problem family and legacy action endpoints stay unchanged.

Actual installed Nest+disposable-PG CI fixtures exercise the mounted path and its
refusals/ABA/receipt/account/epoch/root races; these are source/fixture evidence,
not rollout, native/client or real two-device acceptance. The app's legacy
asset-keyed Unsave still requires its separate consumer migration. No Remove/Undo
UX, selective privacy completion or owner-history operation is claimed here.

## Saved paging

Related: #344.

GET `/v1/saved?pagination=saved-page.v1&filter=all&limit=20` reads a bounded live
keyset page, including exact Saved UUID/ref and actual kind for withdrawn rows.
Legacy empty/limit-only reads retain their original response. The paged branch
checks current root/account/epoch and the Clear barrier before decoding a cursor;
its response validates scope/filter/limit and the exact initiating cursor echo.
All Saved GET answers select private/no-store and a closed 14-code static-error
projection before authentication/query parsing. Logs carry the route template,
never the raw URL, cursor, decoder exception, private anchor or rejected key.

The API composes a separate random AES-256-GCM key per process, with purpose/world
AAD and account/universe/epoch/filter/limit/full-microsecond-key claims. The
versioned cursor lifetime is five minutes. Noncanonical encoding, tampering,
wrong binding, expiry, another instance or restart uniformly return fixed 409
SAVED_CURSOR_UNAVAILABLE. Refresh starts a new traversal; no new secret/env/table,
shared key, persistent cursor store or multi-instance portability is installed.
The framework-free use case sees an opaque codec port only. Ordinary personal
revision/content changes do not turn a live traversal into a frozen snapshot.

Actions-only tests exercise the installed release's native/web guards, 125-row
traversal, current correction/withdrawal, deleted anchors, private errors,
foreign/changed-filter tokens, real second-instance/restart rejection, and the
actual selective Clear barrier. Synthetic codec fixtures additionally prove
expiry boundaries and authenticated IV/ciphertext/tag binding. Source/CI tests
are distinct from deployed disposable-account and native/media acceptance.

### Private Region navigation (U04)

The central `apiControllers` registry mounts `RegionEncounterController` exactly once. Both POST `/v1/experience/region/preview` and `/v1/experience/region/open` use the normal session/native caller and current scope guard, and receive `private, no-store` before Origin/auth/body parsing. Closed problem projection masks rejected values and unrecognized paths. Preview is provider-free and read-only; Open composes the existing session/offer/activation engine with actual Geography and canonical Content ports. The response must echo the exact caller scope, request target, capabilities, displayed expectation and command/session identity. No client geometry, renderer position, operational approval or global fallback enters this API.

U05 (#363) mounts the three strict private POSTs `/v1/universe/formation/read`, `/claim` and
`/acknowledge` through the central controller index and existing Scenes wiring. Cache and closed
problem-family selection occur before Origin/auth/body parsing. All calls still require the
normal current session, X-KS-Scope, root/account/epoch/Clear checks; stored command receipts never
bypass current authority. Read is pure. Claim atomically writes the immutable receipt, once-only
claim and required expiry work, with disposable root hints that may arrive before the HTTP ACK.
The immutable receipt is not current animation permission; clients must use current status and
actual validated targets. ACK records the client's actual shown/skipped statement, not learning
or proof of rendering. No recovery, model or provider call is mounted on a read/status route.

### Friends operations

Related: #374.

The central controller index mounts exactly eleven existing profile/pair operations: own profile
GET/POST, exact handle lookup, pair read and request/accept/decline/cancel/remove/block/unblock.
They use actual session/native credentials, Origin/scope guards and root-held Identity own/pair
barriers. Social reuses the sole private pair aggregate and existing own-account provider; it
binds no invalidation/deletion capability. Current authority/epoch/lineage precedes historical
receipt replay. An old ACK is not current friendship, presence or media authority.

Only those exact mounted methods/paths select the closed Social problem family and private,
no-store before parsing/authentication. Received keys/values and private peer reasons are masked;
responses bind current caller scope, command/operation and selected public identity. Handle
lookup has no prefix search or account/email inference. Invite input remains explicitly unsupported;
visibility/presence and visitor publication remain unmounted declarations (rosters and invitations are
mounted below; conversations and share links in their own section). No contact action creates consumption evidence or model work.
The installed disposable-account CI journey is not populated two-account dev/client acceptance.


### Friends pages and invitation links

Related: #377.

The existing Social controller additionally mounts `friend-pages.v2` POSTs at
`/v1/social/friends/page` and `/v1/social/requests/page`, plus own `GET /v1/social/invites`
and POST `/v1/social/invites/create`, `/revoke`, `/resolve`. Exact finite paths select private/no-store
and closed Social errors before Origin/auth/body parsing. Legacy sharing.v1 list routes remain
unmounted. DTOs bind current caller, requestId/filter/public head, command/link/revision and requested
limits. Empty v2 items with next are scan progress; only next absence means captured scan exhausted.

Existing own/pair Identity gates and sole pair authority remain owning. Roster reads have bounded
current candidates and live eligibility/profile hydration; cursors are plain keyset records that
bind scope/filter/head/limit/anchor and the traversal time bounds. They survive a restart and work
on any instance (D-042).
Invites deliver a secret once separately from a hash-only store/immutable acceptance. Exact retry
never re-delivers it. Resolver and invite-target friend requests check current issuer/token/expiry
before effects/replay. No HTTP model/provider/job, presence, evidence or consumption path is added.
Schema 40 and hosted synthetic fixtures remain separate from real populated two-account/client use.

### Conversations, share links and the landing (D-042)

Related: #242.

`ConversationsController` mounts, all as private POSTs under `/v1/social/`:

- `conversations/start`, `inbox`, `read`, `history`, `changes`, `send`, `send/read`, `mark-read`, `mute`, `leave`;
- `content-shares/create`, `revoke`, `read` (one own link), `list` (own live links, newest first) and `resolve`.

They take the same session, `Origin` and `X-KS-Scope` pipeline as the other Social routes. Each is a thin
call of `CONVERSATION_USE_CASES` that maps a refusal to the closed Social problem family. Authority,
membership, friendship lineage and blocks are decided in the use cases, never here. No handler waits for a
model or a network call. Sending, receiving and opening a card create no consumption evidence.

`ShareLandingController` serves the two public routes (no session needed; D-008 already sends `/s/*` here):

- `POST /s/preview` returns the public metadata of a public link through the anonymous contract.
- `GET /s/:token` returns an HTML page (`share-landing-page.ts`). It has no script. Headers:
  `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex` and a strict
  `Content-Security-Policy`. Content text is escaped. A signed-in caller (cookie read, never required) of a
  conversation link sees "Shared in your conversation" and "Reply in Talk", which opens
  `/conversations/<id>?m=<membership>&r=<revision>`.

Unknown, malformed, revoked, expired, withdrawn and private links all render the same "This link is no longer
available" page with status 200, naming nobody. A read failure renders a "try again" page with 503 and
`Retry-After`, and logs `http.retryable_failure` (`landing_failed`). *Implemented. Not yet run on dev.*

`scope.gateway.ts` subscribes the new `inbox` scope (named by the caller's universe ID) and acks it with
the member's `inbox_heads` revision. Tests: `tests/integration/release/conversations-http.test.ts` runs the
installed API, a typed client, a Socket.IO hint, recovery after a missed hint and the landing states.

### Content threads (#243, D-046)

`ThreadsController` mounts private POSTs under `/v1/social/threads/`: `create`, `read`, `history`, `changes`, `send`,
`respond`, `mark-read`, `leave`, `inbox` and `snippets/open`. The session, `Origin` and `X-KS-Scope` pipeline is the one
the other Social routes use (`request-context.ts` admits the `threads/...` paths). Each handler calls `THREAD_USE_CASES` and
maps a refusal to the closed Social problem family. Membership, friendship lineage, blocks, snippet validity and the
one-failing-friend rule are decided in the use cases. No handler waits for a model or a network call, and no answer
carries any member's position or seen marker. The scope gateway needs no change: a thread bumps the same `inbox_heads`
and hints the same `inbox` scope. Tests: `tests/integration/release/threads-http.test.ts` runs the installed API against
a real PostgreSQL. *Implemented. Not yet run on dev.*

### What if and Another perspective (#244, D-049)

`ScenariosController` (`src/http/scenarios.controller.ts`) mounts private POSTs under `/v1/social/scenarios/`: `draft`,
`draft/read`, `choose`, `list` and `remove`, through the same session, `Origin` and `X-KS-Scope` pipeline as the thread
routes. Each handler calls `SCENARIO_USE_CASES` and maps a refusal to the closed Social problem family
(`invalid_input` to `INVALID_REQUEST`, `stale_revision` to `SHARING_REVISION_STALE`, `command_key_reused` to
`COMMAND_KEY_REUSED`, `budget_unavailable` to `TOO_MANY_REQUESTS`, `unsupported` to `UNPROCESSABLE_REQUEST`,
`unavailable` to `SHARING_UNAVAILABLE`). Membership, the parent's revision, the caps and idempotence are decided in the use
cases; no handler waits for a model. The API also reads `KS_SUPPLY_SCENARIO_DAILY_CAP` and `KS_SUPPLY_SCENARIO_THREAD_CAP`.
Tests: `tests/integration/modules/scenarios.test.ts`. *Implemented. Not yet run on dev.*
