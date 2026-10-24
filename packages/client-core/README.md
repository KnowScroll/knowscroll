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
| `src/recorder/` | Shared Scroll/Reel reading infrastructure. Pure visibility/playback trackers emit bounded `interaction.v1` summaries only for current eligible activation lineage. The scope owns an immutable original-generation `observation-batch.v2` outbox; strict correlated ACKs decide terminal intake, never qualification. See the recording policy section below for legacy migration, loss and lifecycle boundaries. |

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

## Account sessions, export and deletion (#246, D-043)

- `createAccountSessionsSession(scope)`: the person's live sessions (coarse label, last use, current), `end(id)` and
  `endOthers()` then reread; a session already gone counts as ended; a failure keeps the list and says so.
- `createDataExportsSession(scope, newId)`: receipts, `request()` (a fresh id each time), `download(id, open)`
  which mints a one-time link and hands its API-relative path to the platform's `open` once; the path is never
  kept in state.
- `requestAccountDeletion(scope, deps)`: remembers the receipt id **before** sending, sends the confirmed request
  with the epoch the person saw, and on acceptance ends the scope here (`manager.endAfterAccountDeletion()`).
  A refusal forgets the receipt; no answer keeps it, so it can be asked about.
- `AccountScopeManager.deletion` (`createDeletionReceiptSession`): the device's receipt, read without a session
  through `/auth/deletion/{id}` (`DeletionReceiptClient`), kept outside every scope in the key-value store
  (`ks.deletion.receipt`, not purged by a scope ending). An unknown receipt is forgotten: that request never arrived.
  `signed_out.reason` gains `account_deleted`.

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

## Canonical region preview (#362)

`createRegionPreviewSession({ scope, capabilities, newReadId })` owns one ephemeral read-only card
per actual AccountScope object. It requires synchronous `onEnd`, parses the merged U04 contract,
binds the exact read ID/region/object/Geography revision/capabilities/universe/epoch and rejects
regressive root/Geography watermarks. Accepted decoded data is limited to32KiB; this is not a
pre-decode transport allocation guarantee. The card is frozen and is never a cache payload or
storage record. No offer, activation, evidence, request, job or provider operation is created.

`read`, `cancel` and `dispose` own generation/AbortSignal fences. At most one underlying read and
one latest queued selection remain, including when a transport ignores abort. Cancel drops the
card and queued selection synchronously; late replies cannot repopulate it. Authority refusals
clear the card, and end permanently purges listeners/watermarks/queued work before callbacks.
Read failures do not create a fallback encounter or retry automatically. Explicit Refresh starts a
new correlated read. Consumers must also cancel on pin changes, Close, Back, capability changes,
background and owning map-generation changes.

The app's scoped Universe controller retains camera/history privately and passes only the displayed
immutable asset/revision to its existing encounter engine on deliberate Open/More. The engine
validates the region acknowledgement before exact offer activation and retains identical command
and activation IDs on unknown outcomes; a later auth refusal cannot resolve an earlier ambiguous
send. Returning parks the actual renderer/recorder and restores the exact private map frame/focus,
without serializing camera or encounter positions on the region wire. Ordinary series, related,
variant and What-if semantics are not reclassified as region discovery.

This client consumer is fixture-testable against merged contracts. The real preview/Open backend
is not installed by this change: missing/unsupported services remain unavailable, and canonical
coverage/admission authority stays server-owned. Authored protocol/component/exported-browser
fixtures run in Actions only and do not establish real formation, approved mappings, generated
content, device parity or populated dev acceptance.

## Dust read (#238)

`readDustCues(scope, signal?)` calls `POST /v1/universe/emerging/read` and returns `ready` with
opaque cue IDs or a typed `unavailable` reason (`network`, `authority`, `invalid`,
`temporarily_unavailable`). The reply must name this universe and epoch. A cue is not a place: it
has no label, topic or count, and the read never forms anything. Nothing is cached or retried here;
the Universe view session reads again on foreground and when the geography revision changes.
Status: implemented, CI-verified.

## Durable formation presentation client (#363)

`createFormationPresentationSession` consumes the merged `formation-presentation.v1` protocol
through the actual AccountScope. A pure, bounded32KiB accepted-data read must match its request,
capabilities, current scope/epoch/root and exact complete Geography/Scene selection. Every target
must retain its actual creation transition, object revision, parent, kind, label and truth framing.
No client infers a formation from the latest scene or an origin ID alone. Missing services remain
unavailable. A fresh claim command/nonce follows only a current, fresh, claimable server read.

An immutable claimed receipt alone cannot start anything. Current active status must bind its
exact claim and unrenewed expiry, the current projection/capabilities must still match, and the
screen must be foreground. Conservative monotonic deadlines include elapsed request time and
never extend the original300s freshness or30s claim. Mount wins synchronously once before timers.
A64-entry local duplicate fence supplements the durable server uniqueness rule; it is neither a
persistent shown journal nor cross-device authority. Route remounts reuse the scope's controller.

An own-claim root hint may refresh SceneCore before or after the claim reply. A confirmed claim
waits for strict ready projection before its first local start. Once mounted, a transient loading
state retaining the identical validated frozen Geography/snapshot pair can continue that same
attempt; it cannot start or restart one. New ready data must validate every target again. A new
snapshot identity, explicit pending projection, failed read, authority loss, changed target,
capabilities, expiry or background interrupts. This private certificate is purged with the scope.

Unknown claim/acknowledgement outcomes retain the identical command/body and require explicit
retry; focus never resends them. A later4xx cannot resolve an earlier ambiguous send. Completion
requires an actual mounted2400ms full sequence or an actually mounted reduced-motion final still.
`completed` describes that local rendered surface, not durable acknowledgement success. Skip,
background, route leave or projection/capability interruption stops locally and requests skipped.
A pending shown acknowledgement is never replaced by skipped. Late terminal receipts retain the
server's actual disposition. Surface callbacks carry the exact frozen fact reference, so cleanup
or timers from an older presentation cannot alter another one.

Scope end synchronously fences callbacks and purges targets, command bodies, timers, IDs and
listeners; it dispatches no replacement-scope acknowledgement. There is no storage, query body,
polling, extra socket, observation, model call, job or evidence transport. The app draws only its
current canonical descriptor geometry, names only actual fact targets, skips new-system beats
unless matching system/star creations were committed together, and labels hypothetical framing.
Skip is the first focus stop, final status is polite and Done focuses the actual projected place.

Protocol/component/browser cases are authored fixtures and run only in Actions. This source
installs no durable backend/API/worker, creates no supported Geography, approves no mappings and
proves no real cross-device, populated-dev or physical-device journey. Those remain acceptance
requirements under363/238/237/222; models and paid roles remain separately controlled.

## Friends profile, pairs and invites (#377)

`createFriendsSession({ scope, newCommandId })` exposes `getState`/`subscribe` and explicit profile,
exact-handle lookup, pair, invite-status and invite-resolution reads. Construction requires the
actual active AccountScope and synchronous `onEnd`. Every request uses `scope.api`; schema parsing
and scope/operation/command/reference/revision checks happen before publication. The transport
retains at most 64 KiB of accepted decoded output per response; this is not a pre-decode allocation
guarantee. Schema-validated UUID references compare case-insensitively without rewriting wire
values; command/read correlation IDs, opaque cursors and invite secrets remain exact. State is deeply frozen, ephemeral and independent for each scope object. No response,
receipt, cursor or invite token is a query-cache payload, storage record, URL or log entry.

`command(operation, draft)` adds one UUID and the contract version only after an explicit caller
selection. Profile and invite changes require a current corresponding read. Friend requests bind
the exact selected handle or resolved invite issuer; pair actions bind the selected pair/request
and caller-visible revision. A pending or unknown command prevents replacement. `retryCommand()`
is deliberate and sends the identical validated body/UUID. There is no automatic mutating retry.
A later definitive refusal cannot resolve an earlier ambiguous send. A valid immutable ACK clears
current reads; it never becomes a claimed profile, current friendship or active invite. Consumers
must explicitly read again. Stale/conflicting first attempts also discard stale current authority.

Only `takeInviteToken()` can consume a first creation delivery, once. Observable state exposes only
whether that delivery remains available and the separate immutable acceptance. Replay delivery is
unavailable; losing first delivery requires deliberately reading status, revoking that exact link,
and creating a new command after a fresh read. The UI may deliberately copy a link with the token
in its fragment; this package builds no URL and sends no message. A resolved token is retained only
in private ephemeral memory to bind the deliberate request, and an unknown invite request retains
its original secret-bearing body only until ACK or disposal.

At most one underlying read plus one latest queued selection and one command are in flight. Scope
end, authority refusal and disposal synchronously purge reads, receipts, pending bodies, cursors,
listeners and secrets. Generation/AbortSignal fences also reject late successful transports that
ignore abort, including a pre-command read arriving after its ACK. No heartbeat, presence setting,
visitor, visibility, conversation, player position or personal observation consumer is installed.

Tests are authored HTTP/protocol fixtures and run only in GitHub Actions. They do not establish
mounted Friends UI, actual backend availability, real friendships or a connected device journey.
Roster reads use only the separately versioned `friend-pages.v2` namespace/routes, with a fresh
`requestId` from the same UUID supplier (`newCommandId`); an ID on a read implies no mutation.
The response must bind request ID, current scope, selected filter, cursor snapshot and requested
limit. Only absence of `next` ends the captured scan: an empty page with `next` is a scan
continuation, and Next makes exactly one more request. There is no automatic empty-page draining.
The current page contains at most 50 items; eight opaque previous page-start cursors are retained,
with no old page bodies. Previous traverses only that bounded window; Refresh restarts from the
beginning. Stale/invalid continuations discard the window and require explicit Refresh. Repeated
current/retained tokens are refused; the server authenticates finite advancing scan authority.
Legacy `sharing.v1` contracts remain unchanged and are never a downgrade/fallback path.

## Personal recording policy (#381)

`recording-policy.ts` owns one session on each actual AccountScope. Current authority and ACKs are
memory-only; only the minimal exact unresolved set command is kept in scoped storage for reload
recovery, never automatically resent. Storage failure inhibits sending a new policy choice. A strict correlated
current read alone grants collection; initial/refresh/background/network/unknown/scope-ended states
fail closed. The app supplies its platform UUID source. Read ID, target, account, epoch and monotonic
revision/generation are checked. Pause inhibits synchronously before transport. Unknown set outcomes
retain the exact command body and block an opposite choice; a missing receipt cannot cancel an
in-flight command. Immutable historical set/recovery receipts never grant collection, and recovery
requires a separate current read. Clear ends the old scope and reacquires policy; it never resets
the recording generation. Browser focus/storage hints and native AppState recheck authority without
changing account identity or privacy epoch.

New producer commands capture one known original generation, including even/off for necessary
explicit actions, before sending. No missing generation is defaulted or repaired on retry. The
recorders require BOTH a matching current on policy and actual eligible activation lineage. Their
session ID is the exact activation command UUID accepted by Experience. An old offer/producer or
historical ACK cannot create a resumed segment. An existing encounter remains playback-only after
a generation change; a fresh supported encounter/activation is required. Unknown/paused intervals
are discarded, with fresh observation baselines; they never bridge into a later visible interval.

The shared outbox now stores immutable complete `observation-batch.v2` envelopes under
`recorder.outbox.v2`, separated by original generation, with limits checked on the actual envelope.
Delivery uses only `submitRecording`. Strict response schema, exact scope/epoch/generation,
ordered event IDs and per-status counts decide terminal intake. Valid processed and not_recorded
are terminal; unknown/mismatched responses retain the identical body. A not_recorded response
requests a separate policy read, never requeues old events under a new generation. Existing v1
batches have unknowable original generation: adopting v2 explicitly discards/counts them once,
retains the disclosure, and removes the old key without destroying an existing v2 queue. Missing
observations remain unknown, never inferred reading. Storage errors degrade to memory-only delivery.

Web localStorage remains subject to quota/crash loss; native scope storage is still memory-only
and is not crash-durable. Authored race/replay/ACK/segment/UI/browser fixtures are intended for
hosted Actions only. They do not establish real service qualification, native parity or deployment.

## Talk and share links (#242, D-042)

All of these are pure controllers over `scope.api`. They hold no token or body in a query cache or storage, and
they end with the scope. *Implemented; exercised in browsers locally, not yet on dev.*

- `createConversationThread(scope, ref, options)`: reads the snapshot, then catches up with `conversations/changes`
  from the stored cursor. `send(text)` shows a bubble as `sending`, then `accepted`, `unconfirmed` (the outcome is
  unknown: the same command ID is kept and `retry()` sends it again) or `not_sent` (a definite refusal). It marks
  read, mutes and leaves. When a catch-up page first says `ended`, it rereads the snapshot, so a deleted friend shows
  as "Deleted account". `mergeMessages` orders by sequence and drops duplicates, so a hint, a poll and a send
  answer can arrive in any order.
- `createShareSession(scope, target, origin)`: lists friends (the roster plus the inbox, to find an open
  conversation), starts a conversation if needed and sends the card for the exact asset revision, with one command
  ID per intent. `copyLink()` creates a public link and returns its URL once; `stopLink()` revokes it.
- `createSharedLinksSession(scope)`: lists the person's live links and revokes one.
- `readInboxPage`, `findConversation`, `blockFriend` (Talk's menu), and the formatting helpers in
  `talk-format.ts` (`describeMessage`, `inboxRowView`, `listTime`, `dayLabel`).
- `account-scope-socket.ts` subscribes to both `universe` and `inbox`, keeps the highest revision per kind and
  invalidates `scope.queryKey('talk')` (`TALK_QUERY_KEY`) on an inbox hint.
- `@knowscroll/client-core/talk-fixture` (`src/test-support/talk-fixture.ts`) is a labelled in-memory Talk server for tests (it can fail the next call
  as network, unavailable, server or lost response). It never ships in a build.
