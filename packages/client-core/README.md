# @knowscroll/client-core

Client-side cores shared by web, Android and iOS: the typed API client, the TanStack Query client
factory, and the AccountScope (#226: account + privacy epoch ownership of the query client, the
API client, the hint socket and local stores) with the sign-in client, and the interaction recorder
(#229) whose durable outbox belongs to the scope.

| File | Contents |
|---|---|
| `src/api-client.ts` | `resolveApiOrigin()` (D-008: the page origin on the web; the configured world origin on native, HTTPS only; a development build, `allowDevelopmentHttp: __DEV__`, may also use plain HTTP to localhost / 127.0.0.1 / 10.0.2.2), `createApiClient()` (oRPC `OpenAPILink` over `apiContract`; RFC 9457 problems become `ORPCError`s carrying the problem document), `apiProblem()` |
| `src/query-client.ts` | `createQueryClient()`: commands (mutations) never retry; queries retry at most twice and only for network failures and 5xx, after 1 s and then 2 s (`queryRetryDelay` doubles and would cap at 8 s); `shouldRetryQuery`, `queryRetryDelay`. Also exported alone as `@knowscroll/client-core/query-client`, so the root layout does not pull the API client, contracts, Zod and oRPC into the first chunk |
| `src/health.ts` | `healthQueryOptions(api)`: `GET /health` validated against `HealthResponseSchema`, key `['operations', 'health']` (operations data, not account-scoped) |
| `src/account-scope.ts` | `createAccountScope()`: one scope per `(accountId, privacyEpoch)` (`scopeIdOf`) owning its QueryClient, its API client (`fencedFetch`: requests carry the scope's abort signal, its own credential and its claim `X-KS-Scope: <account>:<epoch>`; once the scope ended nothing starts and a late response is dropped with `ScopeEndedError`; the API's `409 SCOPE_MISMATCH` makes the manager reread the session), its socket and its storage (keys `ks.scope.<account>:<epoch>.…`). `end()` closes the socket, aborts and fences in-flight requests, clears the cache and purges the storage, in that order; retained storage handles become inert, so late unmount/HTTP callbacks cannot repopulate it |
| `src/account-scope-manager.ts` | `createAccountScopeManager()`: the single owner of the current scope. `start()` reads the session; `peek()` (whose account a link opens, masked); `redeem()` (the current scope ends **before** the redemption is sent, so nothing it starts can go out with the next credential; a failed redemption remounts the session's scope; native sends the verifier of `SignInBinding`), `refresh()` (a new privacy epoch → a new scope; a refused session → `signed_out: session_ended`), `signOut()` (web: only when the server answered, since only it clears the HttpOnly cookie; native: always drops the secure-store token), `requestLink()` (native: with the S256 challenge of `SignInBinding`); state `starting · signed_out · unavailable · signed_in` for `useSyncExternalStore` |
| `src/scroll-state/` | `createScopedBlockStateStore(scope.storage)`: reader state of Scroll blocks by `(assetId, revision, blockId)` in the AccountScope's own storage, so it is purged when the scope ends. Reads go through the scroll-model `BlockState` schema (anything else is forgotten), writes over 1 KiB are ignored, the newest four revisions of a block are kept, and `earlier()` lets a new revision say it started over. Structurally the `ScrollBlockStateStore` of `@knowscroll/ui`. Personal simulation values never leave the device: nothing here sends anything, and a snippet carries one only when its sender explicitly includes it (`buildBlockStateSnapshot`) |
| `src/sign-in-binding.ts` | `base64UrlOfBytes`, `base64UrlOfBase64`: the encodings of the native verifier and its S256 challenge (RFC 7636; the app's `platform/sign-in-binding.ts` keeps the verifier in the secure store) |
| `src/account-scope-socket.ts` | `connectScopeSocket()`: Socket.IO on the API origin (native: the scope's bearer in `auth.token`; web: the same-origin cookie; both name the scope in `auth.scope`, and a `SCOPE_MISMATCH` refusal makes the manager reread the session), subscribed to the scope's universe; `scope_changed` above the highest revision seen, or `scope_resync`, invalidates the scope's queries; "io server disconnect" makes the manager recheck the session |
| `src/auth-client.ts` | `createAuthClient()`: the `/auth/*` routes as typed outcomes (`requested · invalid_address · rate_limited(retryAfter) · unavailable`, `signed_in · link_invalid · refused · unavailable`), never throwing; anything that is not the contract's answer counts as `unavailable` |
| `src/recorder/` | The reading recorder (blueprint §18 "Shared interaction recorder", S1.6). `observer.ts`: `ReadingObserver`, structurally compatible with `ScrollReadingObserver` in `packages/ui/src/scroll/observer.ts` (client-core never imports `ui`; the app hands the observer to the article). `reading-tracker.ts`: the pure state machine from observer calls to bounded time summaries: per-block visible intervals (at the threshold fraction, **only while the article is active**) and active dwell (active and something visible); an inactive, hidden or overlaid article adds nothing; interactions once per block and kind from scroll-model `INTERACTION_KINDS`, never a value; weights nothing (the server computes coverage and q). `outbox.ts`: the scope's durable outbox (storage quota failures degrade to in-memory delivery): bounded batches (≤ 50 events, ≤ 48 KiB) formed once and persisted in `AccountScope.storage` (`recorder.outbox.v1`), delivered in order, the **same batch with the same event IDs** retried with 1 s → 60 s backoff after network, 5xx, 429 or lock-timeout failures, a malformed or oversized batch dropped, nothing sent or written once the scope has ended; limits (40 batches, 256 KiB) drop the oldest first and count them (a device-sequence gap the server reads as lost events). `scroll-recorder.ts`: `createScrollRecorder` builds `interaction.v1` events (`scroll.block_coverage`, `scroll.active_dwell`, `scroll.block_interaction`) with stable event IDs and device sequence 1, 2, 3 …, flushing every 15 s while there is something to say, on becoming inactive and on `end()`; its first report is always sent so "instrumented, saw nothing" differs from "no instrumentation"; `deliverBatch` classifies the API's answer for the outbox. `scopeOutbox` gives each account scope one shared outbox |

Rules:
- No provider credentials or secrets ever reach this package; the client calls only the API.
- Commands are never resent blindly: an unknown outcome is reconciled through a durable read
  (blueprint §19). Retrying a command belongs to the pending-command queue with stable request
  IDs, not to the query client.
- Account-scoped query keys start with `scope.queryKey(…)` (`['scope', <account>:<epoch>, …]`),
  and every account request goes through `scope.api`; operations keys start with `'operations'`.
- Nothing account-scoped outlives its scope: the app mounts the scope's QueryClient keyed by the
  scope (`apps/client/providers/account-scope.tsx`), so a switch also remounts the screens.

The package exports its TypeScript sources. Its tests (`src/**/*.test.ts`, Vitest, labelled test
doubles for `fetch`) run in CI only: `pnpm --filter @knowscroll/client-core test`.

The Reel recorder emits `reel.playback` through the same scope outbox. Only consecutive visible,
foreground, nonbuffering 1× playback ticks contribute; explicit seek, loop jumps, stalls and gaps reset
the baseline. Coverage is qualified on the server. AccountScope supplies ephemeral native-header/web-
cookie media sources and synchronous playback disposal before its cancellation/cache/storage fence.
No grant URL or credential is persisted. A failing native cleanup cannot prevent scope termination.

For a parked encounter, retain the **same** Scroll/Reel recorder handle and call `suspend()` before
leaving it. Suspension flushes actual reading/playback, closes its active intervals, drops the
renderer/player baseline and stops the Scroll timer. Observer/sample calls while parked are ignored,
including interactions. `resume()` preserves the exposure, session ID, device sequence and original
monotonic origin; parked time stays a gap. Scroll resumes its timer only if `start()` was called and
requires fresh actual visibility **and** activity reports from the renderer. Reel requires fresh
player samples; the first establishes a baseline, so restoring a paused playhead records nothing.
Neither method starts playback or restores a position. The app owns the bounded retained handles,
position restoration and actual foreground/player reporting; Back itself produces no observation.
Start/resume before the renderer reports its new state. The direct Scroll screen starts in its
layout effect, before the article's passive mount/activity reports; native host layout and web
IntersectionObserver callbacks provide subsequent visibility measurements. A retained controller
must resume before mounting/unpausing its renderer and arrange fresh reports even if it stayed mounted.

Use `end()` when discarding a handle. Late callbacks and flushes are then inert. Scroll's explicit
`start()` may re-arm that same handle after `end()` for React development effect cleanup/setup;
it still needs fresh renderer state and keeps the original timeline. Initial observer reports before
the first `start()` remain supported. `start()` does not unpark a suspended handle: use `resume()`.
Reel `end()` is final. Once either recorder observes an ended AccountScope, every method is inert
permanently; the Scroll timer is released on the next lifecycle/observer call or timer tick.

Handles/timebases are in-memory only. After eviction or process restart, do not create a replacement
recorder at elapsed zero for a previously activated exposure. A fresh revisit must open a new
exposure through the authorized encounter flow. Durable outbox batches already formed keep their
original event IDs and retry behavior across parking; suspension does not dispose the scope outbox.

## Readonly Universe session (#238)

`createUniverseSceneSession({ scope, capabilities, selection? })` owns a complete global Geography
and a complete selected Scene in memory. Supply the actual AccountScope and an explicit bounded
capability declaration; no new wire method or credential handle is needed. Construction requires
synchronous `scope.onEnd`, otherwise the session refuses before any work. `start()`/`resume()` attach
one QueryObserver under `scope.queryKey(...)`; the existing hint socket invalidates that prefix.
`pause()` aborts/unsubscribes without polling, `refresh()` explicitly reads again, `select()` drops
the previous selection before fetching another, and `dispose()` is final. Scope end synchronously
purges data, callbacks, selection and owned query markers, with generation/active checks fencing
late or abort-ignoring replies. Two scope objects with the same account/epoch remain independent.

Only the four existing authenticated read-only POSTs run, through `scope.api`. Their API responses
are private/no-store. The session never persists or logs a body, cursor, identity, seed or error;
no geometry, evidence, observation, formation acknowledgement, job, provider or region offer is
created. Queries cache only completion markers. State data is frozen. Consumers must keep
`geography` (current committed meaning) separate from `snapshot.read.manifest.revisions`
(projection inputs); do not paint new labels/activity onto a last valid older Scene.

All replies pass their actual contract schemas and Scene payloads pass the canonical parsers
reexported by contracts. Snapshot paging is complete, stable and global: ten 100-object pages,
identical repeated relations deduplicated, conflicting/expired/looping pages refused. Global
limits are 1000 objects and 1000 routes/aliases. Deltas apply a whole validated batch against the
exact base and component stamps; a gap, unknown effect or four batches still reporting `hasMore`
requires a fresh bounded snapshot. No partial model or convenient subset becomes current.

A Scene generation uses only the selected current manifest's closed chunk references, at most four
concurrent readers. IDs, hierarchy and route endpoints bind across chunks to Geography. Unchanged
older chunk revisions remain valid; a chunk cannot claim newer inputs than its manifest. One stale
manifest reread is allowed; continued churn gets a bounded fresh-snapshot recovery and then a coarse
refusal. The old complete same-selection Scene survives ordinary network/temporary failures and
lag, visibly stale, while authority/epoch refusals clear it. Initial network loading is distinct from
backend loading/lagging with actual `pendingProjection`; empty, unsupported and resource-limit
states never masquerade as one another. An independent validated Geography outline can remain
available when the Scene cannot render.

`UNIVERSE_SCENE_LIMITS` additionally bounds 128 chunks and 8 MiB of canonical serialized data across
the displayed and candidate versions (at most two snapshots). Canonical per-document limits remain
unchanged (262144 bytes, depth12, 12000 nodes, 100 objects/routes per chunk). Generic oRPC decodes JSON
before canonical validation: these are accepted/retained-data bounds, **not a pre-decode transport
allocation guarantee**. Full/low/reduced-motion flags do not reduce wire cardinality or permit
repeated oversized downloads.

Tests are labelled authored protocol fixtures and run only in Actions. This prerequisite mounts no
Universe UI or backend worker consumer; it does not establish populated-device performance, actual
formation, a region-to-Composer seam or durable cross-device shown/skipped acknowledgement. Existing
empty Universe UI and the accepted later layered react-native-svg direction remain separate work.


`createKeepPlaceSession({ scope, newCommandId })` is the ephemeral Keep place foundation; it is not mounted in the app. It requires the actual scope's `onEnd`, uses `scope.api`, and owns one controller per scope **object**, even when two objects have the same account/epoch IDs. `retain(target)` selects lazy details and returns a handle; release it when those details leave the foreground. At most 100 entries (including uncertain commands) and four underlying reads are retained/in flight. Existing scope query invalidation refreshes retained entries; there is no polling, persistence, extra socket or observation transport. The query cache contains only a completion marker, never a position or response body.

A handle exposes authoritative read state, `setPosition`, explicit `retry`, `resolveConflict('server' | 'candidate')`, and `release`. Only a current available server read supplies a membership UUID and CAS revision. An uncertain acknowledgement retains the identical command ID/body and requires explicit retry with live authority; a later candidate coalesces without changing that command. An acceptance triggers a fresh read and is never treated as the current position. A stale CAS presents conflict/current-server state and requires a choice; it never silently overwrites another writer. Membership UUID is checked before revisions, so Unsave/resave cannot inherit a former membership's position or pending candidate. The future renderer must clamp positions against actual immutable media duration or measured canonical Scroll blocks.

Scope end or authority refusal synchronously purges private snapshots, listeners and commands. Generation/read tokens also discard transports that ignore abort after release, membership replacement, or scope end. Ordinary network/read failures may retain a last valid same-membership snapshot under an unavailable state; it is not labelled current. `apiKeepPlaceProblem` is the finite strict problem helper: authorized stale revision metadata is preserved before the generic problem decoder strips extensions; `apiProblem` keeps its existing generic shape.

Authored protocol fixtures cover scope-object isolation, synchronous purge and late replies, CAS/ABA/replay/coalescing, uncertain acknowledgements, required ACK rereads and resource caps. Automated verification runs in Actions only. This source does not establish mounted Keep UX, native/runtime acceptance, a response/lock UX budget, or a production latency SLO; those remain separate consumer/review gates after the actual HTTP probes.

## Manager-owned selective Clear (#345)

`AccountScopeManager.privacy` is an in-memory controller outside the provider's keyed scope subtree.
A deliberate `confirm({ commandId, confirmation: PRIVACY_CLEAR_ACKNOWLEDGEMENT })` sends exactly
one current-epoch body. Accepted, malformed or unknown replies synchronously fence and purge the
old scope before awaiting the real session read. Receipt epochs never construct authorization.
A scope already refreshed by server revocation for the same account stays live; its fresh authority
can read current status. Credential-generation tickets, exact scope identity and operation serials
prevent late clears/recovery/status replies from changing a newer account. Local redeem/signout
attempts and manager disposal purge the minimal pending intent; privacy does not change auth's
existing signout semantics. A credential transition cannot admit a new privacy mutation.

An unknown result retains only the original body and account ID through a same-account privacy
remount. `retryOriginal()` is explicit and sends the same UUID, expected epoch and confirmation
through a fresh current scope; it never substitutes the new epoch. Status reads bind account,
current epoch, requested command/latest selector and immutable known receipt metadata. A
`not_recorded` snapshot cannot prove a delayed original request will never arrive or authorize a
replacement. A definitive rejection of a retry also cannot resolve an earlier ambiguous send;
the original body stays retained for bound status recovery. A new controller after reload reads
latest without creating work. Pending/failed
states cannot mint a replacement clear. No journal, storage, query payload, socket, polling or
private/raw-error logging is added. `completed_live` confirms only live removal, with no backup,
provider-copy or offline-device expiry claim. Tests use authored HTTP/auth fixtures and the actual
manager/fenced transport; automated verification runs only in Actions.
