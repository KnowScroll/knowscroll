# @knowscroll/contracts

JSON-native wire contracts shared by the API and its clients (blueprint §6): Zod schemas, oRPC
contract routes, public IDs and the stable problem-code catalogue. Nothing here runs on only one
side, and nothing here transforms data: parse first, then convert in the receiving adapter.

| File | Contents |
|---|---|
| `src/scenes.ts` | Canonical scene re-exports/validation wrappers, capability negotiation, scoped read-only manifest/chunk declarations |
| `src/problems.ts` | `problemCatalogue` (code → HTTP status, fixed title), RFC 9457 `ProblemDetailsSchema`, `problemDetails()` |
| `src/health.ts` | `GET /health` response and contract |
| `src/identity.ts` | `/auth/*` sign-in and session routes, the link and session token shapes, the session cookie names (D-022) |
| `src/account.ts` | Sessions (`GET /v1/account/sessions`, end one, end others), personal data export (`POST/GET /v1/account/exports`, one-time link), account deletion (`POST /v1/account/delete`) and the session-less deletion receipt routes under `/auth/deletion` (#246, D-043); `DELETED_ACCOUNT_LABEL` is the placeholder every shared surface shows for a deleted account |
| `src/operator.ts` | Operator panels and one record's journey (`GET /v1/operator/panels`, `/v1/operator/journeys/{id}`): operators only, 404 for everyone else, IDs and codes only (#248, D-044) |
| `src/privacy.ts` | Declaration-only selective Clear exploration intent/acceptance, current coarse status and closed local problems |
| `src/recording.ts` | Declaration-only recording policy read/set, immutable original receipts, current generation and closed private problems (#376) |
| `src/router.ts` | `apiContract`: every HTTP route the API serves |
| `src/content.ts` | Re-export of the canonical `ScrollDocument` (`scroll-document.v1`) and `ClientCapabilities` from `@knowscroll/scroll-model`; never copied, and never its internal provenance or producer entries |
| `src/saved-page.ts` | Versioned live Saved keyset pages, exact membership/format/availability rows and closed private list problems (#344 declaration prerequisite) |
| `src/experience.ts` | `POST /v1/actions`, `GET /v1/saved`, and the exposure routes: `POST /v1/experience/open`, `POST /v1/experience/activate`, `GET /v1/experience/exposures/{id}/document` |
| `src/navigation.ts` | Composer session discovery, `POST /v1/experience/navigate`, semantic intents, prepared public offers, ready/pending/exhausted receipt outcomes and offer activation |
| `src/region-encounter.ts` | U04 declaration-only side-effect-free preview, exact displayed-target Open expectation, scoped Composer outcome and closed problems |
| `src/formation-presentation.ts` | U05 declaration-only read, cross-device claim/current eligibility and shown/skipped terminal acknowledgement |
| `src/supply.ts` | Declaration-only topic/format-variant requests, immutable acceptance/cancel receipts and current private request status; topic/variant HTTP declarations in `apiContract.supply` (#239 prerequisite; adapters pending) |
| `src/geography.ts` | Established geography pages, retained routes/aliases, typed applied universe deltas and the unlabelled dust cues (`geography.read`, `.deltas`, `.emerging`) |
| `src/interactions.ts` | `interaction.v1`: the observation envelope, three `scroll.*` payloads and bounded paired `reel.playback` intervals; `observation-limits.v1` (shared with the recorder), `POST /v1/observations/batch` and the dev-only `GET /v1/diagnostics/exposures/{id}/evidence` |
| `src/media.ts` | `reel-document.v1` and `POST /v1/media/grants`: a session-scoped short-lived playback grant for an existing exposure |

Reel targets and playback payloads use the media adapters (#233); declaring either creates no
consumption evidence. A playback grant is kept in memory only; its URL must never enter logs,
persistent storage, caches or diagnostics.

Explore contracts precede their consumers (#234). The existing `/v1/experience/open` accepts the
original direct `{target: {kind: scroll|reel, assetId}, origin: {kind: direct}}` command or a new
`{target: {kind: discover}, capabilities, session?}` command, or an explicit Saved-first revisit
`{target: {kind: return, assetId, assetRevision}, capabilities, session?}`. The revisit may create a
session without a current offer/exposure; it rechecks admission/access and the exact immutable
revision, including withdrawal. Discovery and revisit omit `session` for a new session;
resuming supplies both `sessionId` and `expectedIntentRevision`. Direct open still returns its
original exposure object. Discovery, explicit revisit and navigate return `status: ready|pending|exhausted`, a
Composer session ID and intent revision; a prepared offer is **not** an exposure. Offer activation
uses the same `/activate` route with `target: {kind: offer, sessionId, offerId,
expectedIntentRevision}` and must independently recheck authority and eligibility. Session IDs in
these shapes identify Composer sessions, not authentication sessions. Receipts remain immutable:
a pending replay is pending; a new, authorised session read/open intent can obtain current supply.

Compatibility: legacy objects keep their existing unknown-field stripping, with three narrowly
reserved new discriminator fields: `target` on direct activation input, `status` on direct-open
output, and `sessionId` on direct-activation output. Their presence must satisfy the new branch;
malformed or mixed new shapes cannot downgrade to legacy effects. Other unknown legacy fields
still strip. New navigation/offer objects are strict. Save/Unsave keep their original `saved`
response; Like/Unlike/Hide have separate `liked`/`hidden` state. Saved metadata is optional for the
interim ID-only adapter and allowlists only kind/title/summary/language and availability/revision.
No internal source, provenance, model or ranking data is a consumer field. Decision IDs are opaque
ops correlation only.

`GET /v1/experience/exposures/{exposureId}/context` declares a current, authorised read for an
owned activated exposure at its exact asset revision and epoch, with current content eligibility
rechecked. It creates no exposure. Its strict public response contains current `actions`
(`saved`, `liked`, `hidden`), existing format availability, an optional admitted series position,
and bounded `seriesPrevious`, `seriesNext`, `related` continuation states. A ready continuation
has a real admitted link ID, immutable target, public metadata and a series-step or related-move
relation; it grants no rendering authority. Pending has only a real authorised durable request
ID; unavailable has only its reason. No future Part total, offer/exposure, scores or positions are
invented. A Composer member's optional `session` supplies both session ID and the **latest**
server intent revision for catch-up; direct exposures omit it. Mutable action state belongs to
this read, not an immutable offer or receipt snapshot.

Only series/related navigation can include optional `expectedContinuation`
`{linkId, assetId, assetRevision}`. A displayed ready card binds that exact admitted link and
revision for revalidation; a stale card must not silently change destination. Omission retains
generic ranking/resolution. `from` may be any previously activated, still-authorised/eligible
offer and exposure in the same session and epoch, including a locally restored parked entry.
`expectedIntentRevision` always fences the latest server session intent, not that entry's old
capture. Back sends no command; only a subsequent deliberate move starts a new intent.

Actions may include optional `exposureId`, checked against an owned activated exposure at the
same epoch and exact asset revision. With no linkage the action is asset preference only: never
guess the newest exposure, create qualification, or award an encounter bonus. Other unknown
legacy action fields still strip; malformed explicit linkage is refused, not stripped. Saved
`currentAssetRevision` is allowed only with `availability: corrected` and a revision **different
from** the immutable saved revision; replacement ordering is not assumed.

The prerequisite API explicitly refuses discovery/revisit open, navigate, offer activation,
context reads, exposure-linked actions (including Save/Unsave) and Like/Unlike/Hide
with `EXPERIENCE_COMMAND_UNSUPPORTED` before legacy use-case effects. The direct client rejects a
Composer outcome as a controlled session error. These declarations do not implement Composer,
new action/evidence state, Saved metadata hydration or any Explore UI. No #234 runtime acceptance
is claimed. Direct Scroll and Reel encounters use their implemented adapters; the prerequisite
refusals above apply to the future Composer and action consumers.

Vertical discovery, declared series next/previous, admitted related moves, existing format variants
and explicit new revisits are distinct intents. A missing variant is unavailable unless a real
existing content request makes it pending; navigation starts no production. Ready buffers hold at
most three distinct explanations, including the current offer, so another format cannot duplicate
a buffer slot. Natural exhaustion contains no phantom next part. Parked Back restoration is local
AccountScope state: exact Scroll block + offset, Reel playhead and paused return state remain
private there. It sends no navigation/activation command and earns no fresh return contribution.
An explicit open revisit can start from Saved before any current encounter exists; an in-session
navigate revisit names its current offer/exposure. Both create fresh lineage only after activation
and still require actual qualified observations; neither overrides withdrawal or changes the saved
immutable revision.

Supply prerequisite (#239): `CreateContentRequestSchema` declares a fresh deliberate topic ask or
format-variant request, with one command ID retained unchanged on transport retries. Topic asks
have bounded nonblank text (at most 500 UTF-16 code units) or a `content-concepts.v1` topic/facet
reference; catalogue syntax is not membership, meaning or permission. Topic `format` permits
Reel/Scroll/Either; variant `to` permits only Reel/Scroll, without a second format assertion.
`language` and canonical `ClientCapabilities` travel with either branch. Optional topic `context`
means About this; omission means Something new. Variant `source` is mandatory. Either source
names the exact immutable asset revision and owned activated exposure; optional Composer session
linkage must match that exposure and the latest intent revision. The consumer must independently
recheck authority, epoch, admission, rights, topic/facet membership and variant explanation identity.
Neither a source reference nor an ask creates consumption evidence or grants paid permission.

`ContentRequestReceiptSchema` is immutable acceptance, containing a real committed private request
ID, original recorded time, epoch and personal catch-up watermark. Demand, receipt and required
pg-boss work commit together; retryable authority/stale-input refusals write no receipt. Terminal
unavailability can live on an accepted durable request's current status. An identical replay
retains the original acceptance, epoch and watermark (only the transport `replayed` marker differs),
even if supply is now ready. Reusing the command ID with different input is a conflict. Current
authority is rechecked before any replay; an old epoch cannot reveal an old private result.

`ReadContentRequestSchema` and `ContentRequestStatusSchema` describe the separate current private
resource read: preparing (`requested` or `preparing` phase), ready, unavailable or cancelled.
Every snapshot has a version, current epoch, request revision, timestamps and personal revision
for catch-up. A ready snapshot contains only an admitted immutable content reference, explanation
identity and existing allowlisted encounter metadata. It grants no exposure or rendering authority,
never switches the encounter and still needs explicit subsequent open/activation. Withdrawal can
change ready to unavailable at a newer request revision. Preparing requires a real authorized
durable request; unavailable carries only a fixed coarse reason, never provider error text.
Polling, reconnect, opening the request sheet and navigation create no production or paid attempt.
Clients fence responses by AccountScope, keep the highest personal watermark, refetch after scope
hints/reconnect, and refuse to overwrite a newer request revision with an older snapshot. Offline
UI must mark a retained snapshot as potentially stale; no percentages or ETAs are declared.

`CancelContentRequestSchema` has its own command ID and private request ID.
`CancelContentRequestReceiptSchema` keeps the original `cancelled`, `already_cancelled` or
`already_closed` outcome after commit; ready/unavailable requests are already closed. Cancellation
removes only this person's waiter. It does not recall dispatched paid attempts, promise refunds,
delete admitted content or cancel other waiters/shared work. Current status remains a separate
read, and cancel replay has the same authority, epoch and canonical-input protections as creation.

Supply owns no public sharing keys, grants, model parameters, prompts, sources/provenance panels,
private evidence/scores, provider outputs/errors, balances or other waiter identities. Owner and
epoch are derived from authenticated AccountScope rather than accepted from request bodies.
Freeform text and source context remain private: the backend must construct and admit a public
canonical brief before any shareable key, with rights, current authority and budget checks.
No private thread/scenario inputs are declared here. Strictness applies to these new owned objects;
canonical capabilities, session and metadata schemas are reused with their existing semantics,
without changing legacy navigation/experience parsing or reserved discriminators.

The shared `apiContract.supply` now declares `POST /v1/content/requests` (immutable acceptance),
`GET /v1/content/requests/{requestId}` (current private status), and
`POST /v1/content/requests/cancel` (immutable cancellation outcome). Both commands use HTTP 200,
including exact replays; acceptance is distinct from ready and never promises paid work. Cancel
uses only its body request ID, avoiding competing path/body identities. Status GET has no request
body and never creates demand, retries production or activates an encounter. The future adapter
must apply the existing first-party origin/session/AccountScope guards and map typed refusals to
fixed RFC 9457 problems; it must not disclose another person's request existence. These are HTTP
**declarations**, with no controller/client binding in this prerequisite. The already merged Supply
backend public capabilities must be connected in the subsequent adapter PR. No new endpoint is
claimed served or runtime-verified here; these declarations do not complete #239. Series-next/related
commissioning needs a separate Content-owned admitted future-slot/move declaration and usable
consumer-facing revision; current links point to admitted assets, so no future Part or pending
target is invented here. E07's bounded private request list and explicit retry on the same request
ID need separate future declarations. Such retry must use a fresh retry command ID and recheck
authority, budget, fences and attempt ledger; replay/poll never implicitly retries production.
There is no Supply/Planner/Cartographer paid allowance in this prerequisite; D-024's #232 allowance
and owner-only Reel script approvals are unchanged. No backend, UI, queue or runtime acceptance is
claimed by these declarations.

## Geography reads

Related: #237, #238.

`ReadGeographySchema` and `GeographySnapshotSchema` declare authorised **own-universe** reads of
established systems, organising stars, subtopic planets and finer regions. Systems parent to the
universe; stars and planets parent to a system; regions parent to a planet. UUID identities and
immutable `originTransitionId` belong to geography, independently of scene descriptors, visual
families, generators, layouts, seeds and detail levels. Labels do not encode mastery or beliefs.
`factual`/`hypothetical` status is explicit; an alias cannot silently turn hypothetical meaning into
a fact. Activity is a coarse server-supplied `active`/`quiet` display state or explicitly unavailable,
never a score. Quiet activity does not remove established structure.

Each snapshot carries the authorised universe/epoch, current personal-root watermark and geography
revision. Structure/activity revisions are the latest geography commit that changed each component,
not counts or Personal Context revisions. Consumers fence by AccountScope, universe and epoch,
then reject regressions in either personal watermark or geography revision. These stamps do not
claim complete historical evidence, qualification or learning. Backend formation must use the
current separate trusted PC coverage capability under the same live personal scope; the legacy
global covered-facets snapshot remains unavailable and no numeric formation policy is frozen here.

`empty` means no established objects in the selected universe/system. `loading` requires actual
initial projection work; `lagging` retains a valid established page while real pending work catches
up. `unavailable` distinguishes temporary failure, expired snapshot and result-limit refusal.
None of these states invents dust, planets, social activity, evidence counts or future rewards.
Pages allow at most 100 objects, 100 routes and 100 retained aliases. A continuation binds universe,
epoch, selection, geography revision and last object ID; the server validates it, pages in stable
ID order, and refuses an expired revision. Endpoints may name objects on other pages. A relationship
overflow must fail with `limit`, never silently truncate relationships or assert completeness.
No cursor or public ID grants permission. Friend/visitor projections require later sharing contracts.

`UniverseDeltaSchema` declares one atomic **already applied public effect**, with base/current
revisions, immutable transition ID and at most 32 typed operations: `create_system`, `establish_star`,
`form_planet`, `add_region`, `connect_route`, `revise_label`, `set_activity`, `withdraw_relation`.
Effect revisions equal the commit revision; new identities retain that transition as their origin.
Label/activity updates cannot replace origin identity. Relation withdrawal retains its ID/endpoints
in subsequent snapshots; aliases retain old identities after a reviewed correction. Merge/split
proposal and alias-creation mechanics remain backend-local and need a future typed delta extension
before incremental alias updates; clients refetch snapshots rather than inventing such operations.
There is no arbitrary JSON patch, client formation command, eligibility override, model proposal,
private evidence, source, score, prompt, provider or validation-receipt payload on this wire.

`ReadUniverseDeltasSchema` and `UniverseDeltasSchema` declare read-only catch-up, at most 10 deltas
per page. Available results are contiguous, unique and scope fenced; unavailable retained history
requires a full snapshot. Consumers apply a whole delta against the exact base or refetch. Repeated
delivery and scene rebuilds preserve the same transition ID. U05's once-per-transition presentation
can key on that ID per account/epoch; durable cross-device shown/skipped acknowledgement still needs
its own consumer implementation. Reads must never enqueue work or dispatch a provider attempt.

The HTTP declarations are `POST /v1/universe/geography/read` and
`POST /v1/universe/geography/deltas/read`, with the existing strict read schemas and response unions.
These are read-only operations: POST preserves the bounded nested selection/cursor JSON without
inventing string codecs or a second query schema. Neither route is a cartography command or shown/
skipped transition acknowledgement. The API adapters retain the existing origin/session/scope
guards and current own-scope backend reads; a cursor or revision grants no authority.

`POST /v1/universe/emerging/read` (`universe-emerging.v1`, D-038) takes an empty body and returns
`dust`: one opaque, unlabelled cue for each catalogue system that qualified reading has reached and
that is not established yet. A cue carries only an ID that is stable for the universe and epoch. It
has no label, topic, count or promise of a future place, and it is not a geography object. The read
is own-scope, read-only and never enqueues cartography. The response also carries the geography
revisions it was read against, so a client can pair it with a snapshot.

These HTTP declarations alone grant no authority. The separate Geography API read adapters are
implemented on integration, using the current own-scope backend reads and existing guards. This is
source implementation, not dev/live formation or deployment acceptance. The Geography backend owns
proposals, current trusted authority, policy, atomic application, durable deltas and erasure.
Neither a declaration nor a read establishes real maps/coverage, a Cartographer run, scene projection
or UI/native/browser behaviour. Scene routes declared below are still not served or projected;
scene descriptors/manifests and projection have separate versions and consumers.
`geography.test.ts` contains synthetic wire-validation fixtures only; automated suites run in Actions.

Rules:

- A problem code never changes meaning; a new meaning gets a new code. Codes double as
  `reasonCode` in diagnostics.
- Job payloads, model outputs and internal projections are backend-local and never live here.
- Allowed imports: `zod`, `@orpc/contract` and the public entries of
  `@knowscroll/scroll-model` and `@knowscroll/scene-core` only (enforced by dependency-cruiser, `contracts-are-wire-only`).
- `src/openapi.test.ts` covers every route, direct/Composer unions and RFC 9457 errors.
- `src/navigation.test.ts` covers compatibility, intent fencing, bounded public metadata, distinct
  pending/exhausted states and downgrade refusal. Automated suites run in GitHub Actions only.
- `src/supply.test.ts` covers topic/variant branches, bounded input, real-reference shapes, immutable
  receipts versus current status, cancellation and strict refusal of private/internal fields. It
  establishes wire validation only, never actual admission or database authority.

Build: `tsc -p tsconfig.build.json` → `dist/`. Inside the workspace, TypeScript, Vitest and
dependency-cruiser read the sources through the `@knowscroll/source` export condition
(`docs/v2/engineering/workspace.md`).

## Scene reads

Related: #238.

`POST /v1/universe/scenes/manifest/read` and
`POST /v1/universe/scenes/chunks/read` declare bounded, read-only **own-universe**
scene reads. POST preserves one strict JSON selector/capability/reference shape,
consistent with Geography reads. They are declarations only: no API controller,
projection worker, renderer, browser/native journey or deployment acceptance is
implemented here. Reads must not enqueue projection, formation or model work.

`SceneDescriptorSchema`, `SceneChunkSchema`, `SceneManifestSchema`,
`SceneReturnLocatorSchema` and their TypeScript types are canonical scene-core
re-exports. The `*WireSchema` Zod wrappers call those exact `safeParse` guards,
without transforms or a second scene DSL. Successful values retain their JSON
shape. Untrusted raw scene JSON should still use the core `parseJson` entry to
check UTF-8 bytes before native JSON parsing; the HTTP adapter must enforce its
body ceiling before decoding. The core guards retain total byte/depth/node caps,
strict nested keys, plain host-object checks, non-executable data and stable
identity/hierarchy constraints. Wire validation establishes no access authority.

`SceneClientCapabilitiesSchema` advertises unique bounded version lists for
manifest/chunk/descriptor/generator/family support, plus `full`/`low` detail and
reduced motion. Unknown bounded versions can be parsed and receive
`unsupported_version` with no scene payload. This first protocol requires the
v1 manifest, chunk and descriptor, `silhouette.v1` and all three current families;
it never substitutes a different generator/family to make a scene render.
Rendering quality changes preserve object/family/generator/seed/anchor/target,
truth and activity identities. Responses echo the exact selector and capability
advertisement; the future adapter and AccountScope consumer must compare them to
the initiating read. Extra supported version strings do not authorise new output.

Every response separates the current authorised universe/epoch/root
`personalWatermark`, current committed `currentGeography` stamps and current
`sceneRevision`. The canonical manifest/chunk revisions describe projection
**inputs**: geography/structure/activity stamps, the scene's own publication
revision, and `personalRevision` (the personal-root watermark read with that
projection input, not a Personal Context revision). Within the same scope,
projection inputs cannot exceed their corresponding current stamps; no number
is compared across unrelated revision domains. Consumers fence by their existing
AccountScope, universe and epoch, retain the highest current personal/Geography/
scene stamps independently, and refuse regressions or responses to an obsolete
read. New personal activity alone does not prove that Geography or scenes changed.

`empty` contains an actual empty canonical manifest, without placeholder worlds.
`ready` contains a nonempty current manifest. `loading` contains no manifest and
requires an actual pending projector target. `lagging` retains the last valid
manifest and requires a newer pending geography/root input. The future backend
must verify real queued work; wire declarations cannot prove a job exists.
Pending targets cannot name uncommitted future input. `unavailable` carries only
fixed coarse reasons (`temporarily_unavailable` or `limit`), never provider text.
These states make no promise of formation, coverage, mastery, ETA or progress.

A chunk read binds universe/epoch, selection, exact `manifestSceneRevision`,
`chunkId`, `chunkSceneRevision` and the capability advertisement. Chunk revisions
may be older than the current manifest revision when that immutable chunk is
still referenced. The future adapter must recheck current session, first-party
origin, `X-KS-Scope`, current epoch, manifest membership, selection and
capabilities under the owning scope. A guessed universe/chunk/revision never
grants permission. An expired manifest or unknown chunk returns `unavailable`
with `stale_manifest`/`unknown_chunk` and **no chunk payload**, never an arbitrary
historical chunk or silent downgrade. A valid chunk may contain zero objects;
its read never invents them. Account IDs, owner selection, visits/public sharing,
private evidence/scores, model/provider fields and executable HTML/SVG/asset URLs
have no slots on these contracts.

`SceneReturnLocator` is private client navigation metadata, including exact
bounded coordinates, scale and optional object focus. It is not sent by either
HTTP route, never a shown/skipped acknowledgement, formation authority or durable
receipt. AccountScope must purge both private cached scenes and return locators
on account switch, logout and privacy reset. No acknowledgement route is declared.

### OpenAPI generation

Scene-core owns the structural `*JsonSchema` metadata too. Cross-field and
host-object invariants remain the canonical parser's responsibility; structural
metadata is not an alternative validator. The supported Zod converter requires
an interceptor for the custom wrappers. At the **dev/server OpenAPI generation
boundary**, configure it as below (as exercised for every route in
`src/openapi.test.ts`). There is no served OpenAPI generator yet. Shared clients
import no OpenAPI generator or converter registry at runtime.

```ts
const converter = new ZodToJsonSchemaConverter({
  interceptors: [(options) => {
    const scene = sceneWireJsonSchemas.find((entry) => entry.schema === options.schema);
    return scene ? [true, scene.jsonSchema] : options.next();
  }],
});
```

`sceneWireJsonSchemas` maps exact Zod wrapper identities to canonical metadata;
it copies no descriptor fields. This uses the converter's supported interceptor
API: default conversion of a Zod custom validator would otherwise be an
unrepresentable schema. `scenes.test.ts` and core metadata tests are synthetic
protocol fixtures only, run by GitHub Actions. No database, real-world projection,
rendered world, native performance, provider budget or completed #238 is claimed.

## Friends and visibility

Related: #241.

`sharing.v1` declares strict JSON-native profile/handle, exact lookup, paged own
friends/requests/blocks, explicit pair commands, own invite-link lifecycle,
visibility/presence preferences and a separate permission-filtered visitor read.
These are declarations only. No Social endpoint, database table, account lifecycle,
server filter, presence heartbeat, projection, consumer or deployed journey is
implemented by this package. Messaging, threads, scenarios, rooms, transport and
provider work need separate contracts. AI is not accepted in these real-account
person references; future participant unions must explicitly label AI.

Handles are explicitly chosen 3–24 lowercase ASCII letters/digits with internal
`.`/`_` separators, no adjacent/final separators (including `asha.k`). Public
people contain only opaque public person ID, handle and chosen display name;
public person IDs are not account/universe/root locators. No email lookup/default,
prefix directory, address-book upload, private activity or fabricated contacts.
Lookup and invite resolve are authenticated **POST** bodies with one coarse
unavailable answer for absent/hidden/blocked/inactive identities.

`apiContract.sharing` declares GET own profile, invites, visibility and presence
preference; POST updates on profile/visibility/presence preference; POST
`/v1/social/people/lookup`, `/pairs/read`, `/friends/read`, `/requests/read`,
`/friends/request|accept|decline|cancel|remove|block|unblock`,
`/invites/resolve|create|revoke` and `/visits/read`, all with `/v1/social` prefix.
The bounded nested list cursor stays JSON on POST rather than inventing a query
codec. Fixed API paths contain no handle, person or capability. Future adapters
retain first-party Origin/session/`X-KS-Scope` enforcement.

Every command uses one command ID and exact validated body across uncertain
transport retries. Explicit expected resource revisions bind authority;
request selection also binds the exact resolved public person ID. Receipt replay
requires **current** scope/epoch/account and relevant pair/visibility access
checks first. Accepted receipts remain immutable, distinct from current resources;
changed canonical body returns `COMMAND_KEY_REUSED`. Retryable stale/busy/access
refusals write no success receipt. No declaration/receipt/cursor is a grant.

`pairRevision` is explicitly **per-caller public relationship-view** revision,
independent of recipient-private/internal pair transitions and presence expiry/
preference. Private events cannot advance sender-visible list snapshot revisions. Silent decline must preserve the
sender's outgoing view, fixed public expiry and public revision until that expiry;
neither staleness, list revisions nor problem details may reveal the decline or
another side's block. The backend separately fences actual locked internal pair
authority. Sender views have no declined/peer-blocked state or recipient timestamp.
Reciprocal requests require explicit Accept; unblock restores no friendship or
visibility publication. Own block state is visible only to its actor.

Pages contain at most 50 unique matching rows, no total/private counts. Cursors
bind owner AccountScope, epoch, filter and immutable list snapshot revision;
the backend validates opaque cursor authenticity and current authority before
use. Membership/order belongs to that snapshot; presence is separately evaluated
under current authority/expiry per page, never replayed from an old snapshot lease. Changed/expired snapshots require a fresh page. Clients compare initiating
scope/filter and refuse regressions rather than merging different snapshots.
Wire validation cannot prove current database authority or cursor authenticity.

Invite capability secrets appear only in sensitive input bodies or ephemeral
first delivery. Only the acceptance/link reference is durable: never persist raw
secret in an ordinary receipt, queue, log, notice, API path or own-status read.
A create replay returns the same accepted link reference and unavailable delivery.
After losing the first delivery, deliberately revoke that link then issue a new
create command. No implicit token reissue. Opening/resolving a link never sends
or accepts a request; each side explicitly acts. Revocation leaves already
accepted friendships unchanged. Lifetime/heartbeat/cooldown numbers remain
future runtime policy, not values frozen from the planning proposal.

Visibility chooses nobody, chosen friends or all friends **and** explicit own
system selections; widening an audience never auto-selects systems. Own settings
may name own Geography IDs; visitors never receive them. Intended future defaults
are nobody and hidden presence, not schema transforms or database seeds. Pair,
visibility, published projection, presence preference and presence expiry revisions
have distinct meanings. Visible availability has a relative `validForMs` freshness
lease (one-day transport ceiling, no selected heartbeat policy), conservatively
aged from request start. Future adapters check actual expiry on every read and
clients discard expired/lost-freshness presence. Hidden, expired and unknown have
one constant `{state: "unknown"}` public shape without revision/TTL; never exact peer event/last-seen timestamps or playback.

Visitor output is a **separate public projection**, initially `list.v1` only:
explicitly shared system labels and opaque publication-scoped public system IDs.
These IDs must be generated for that public scope and never serialize private
Geography/Scene/universe IDs. No private descriptor is reused and no new geometry
DSL is invented. Graphical U06 rendering needs a separate reviewed public geometry
extension; this prerequisite does not claim the complete visitor UI. Lists are
bounded at 100 disclosed systems; overflow is unavailable, never private-count
truncation. Empty lists assert only no disclosed systems. Generic haze/banner are
constant consumer decoration, independent of hidden-world existence or size.

Future reads recheck active accounts, accepted unblocked pair, current visibility
and publication before returning the allowlist. Optional expected pair/visibility/
publication revisions are exact checks, never permission; stale/denied/unpublished
answers are uniformly unavailable without projection. Available responses echo
selected target/capabilities and bind the public owner. Consumers compare request,
AccountScope and independently monotonic revisions and purge on access/scope loss.
No coordinates, gaps, private counts/IDs, private history, evidence, peer presence
timestamps, playhead/seen/branches, personal watermarks or personal seeds occur.
Visits cannot form worlds, supply evidence or grant source access. Strict schemas
cannot establish that a future server generated truly public IDs/labels; backend
allowlist and denial/revocation tests remain mandatory before consumers ship.

`sharing.test.ts` and focused real OpenAPI-generation assertions are synthetic
wire fixtures, run only in GitHub Actions. They establish no actual friendship,
expiry, transaction/replay safety, privacy completion or #241 acceptance.

## Keep places

Related: #246.

`keep-place.v1` declares `apiContract.keep.read` (POST `/v1/experience/keep/read`)
and `setPlace` (POST `/v1/experience/keep/place`). Both take strict JSON bodies;
private IDs and positions never enter URLs. These declarations install no HTTP
route, storage, client persistence or privacy operation. Future adapters must
apply first-party Origin, session and `X-KS-Scope` guards, private/no-store
responses and current account/epoch authority. No observation, exposure,
activation, media grant, Evidence job, provider work or consumption is created.
This is a narrow private Keep position wire exception, not a new field on
observations, navigation, public content or Social.

A read targets an exact immutable asset revision. The future backend binds the
actual `saved_items` reference and a separately minted `savedEntryId` for that
membership. Same Save preserves it; Unsave deletes membership/place; resave mints
a different identity. Do not derive it from legacy Save's no-op receipt: that
receipt can echo the requested revision while the retained Saved ref is older.
A different requested revision returns `not_saved`, without redirect/inheritance.
`saved_unavailable` retains only the exact entry reference; withdrawal, correction
and other current ineligibility expose no position, metadata, replacement revision
or timestamp. Only `available` has place `none` at revision 0 or `set` at a positive
revision. Scope/target echoes and entry equality fence responses on the client.

Positions preserve fractional milliseconds for Reel and fractional logical pixels
inside a canonical top-level Scroll `LocalId` block. Finite nonnegative values up
to `Number.MAX_SAFE_INTEGER` are a **transport representation bound only**.
Future validation uses the actual immutable media port/duration (the current Reel
document validator permits 20–60 seconds); a future codec must not inherit a copied
60-second universal limit. The renderer clamps Scroll offset after layout to its
actual measured block/viewport. Server code cannot invent geometry from private
font/viewport assumptions or reinterpret a nested child offset as a parent offset.

Set uses one command ID and exact body across retries, current membership identity
and a nonnegative expected place revision. Every new accepted Set increments once,
even for equal positions; counter exhaustion refuses without effects. Current
scope, exact entry/reference and current content eligibility must be checked
**before** looking up an immutable receipt. An authorised identical replay precedes
checking its old CAS revision; changed canonical input is `COMMAND_KEY_REUSED`.
Acceptance contains the committed entry and base/accepted revisions, never position
or a current snapshot; `recordedAt` is receipt time, not encounter time. Old
acceptance grants no access. Unsave/resave, withdrawal/correction, scope/epoch
change and suspension must fence old commands and replay. Two devices get one CAS
winner; only authorised staleness reveals current revision, never current position.
No wall-clock winner or blind overwrite/retry loop is implied.

Future storage follows own personal-root then existing Identity authority gate,
exact membership/place and reviewed Content eligibility locking; receipt, place
and required catch-up/hint effects commit atomically. No peer root or competing
fence is introduced. Clients retain the highest current revision only within the
initiating AccountScope and membership. Legacy asset-keyed Unsave still has an ABA
limitation and is outside this contract slice. A future local transfer must first
read the current entry and revision 0, then issue a fresh command; bulk import or
overwrite of a server place is not authorised. Park/explicit-exit coalescing and
bounded retries belong to a later client adapter, separate from lossy observations.
D025 local Back restoration grants no fresh activation/contribution. Scope end
stops callbacks, discards late responses and purges scoped local positions; retained
server Keep requires a fresh authorised read. Existing all-data erasure still
deletes Saved; this prerequisite changes no deletion/preservation behaviour.
Identity 309 is an authority gate and account-table inventory is not a deletion
executor. The later storage/API/client/erasure work remains separate.

`KeepPlaceProblemSchema` is a finite strict RFC 9457 union with fixed catalogue
code/type/title/status. Only `KEEP_PLACE_REVISION_STALE` requires a current place
revision. No arbitrary detail/instance, rejected key/value, entry or position is
allowed. Bounded validation issues use only static schema-owned field tokens
(or `unknown`), no numeric segments; unknown keys must map to an empty root path
or the fixed mask, never be copied. Global `ProblemDetailsSchema` is unchanged.

The real oRPC generator normally wraps error `data` in an RPC document. Keep's
supported `route.spec` callback instead selects the converter-produced defined
error data schemas per status and describes them directly as
`application/problem+json`; unexpected generator structure fails closed. This is
OpenAPI metadata, not an HTTP exception serializer. The actual generator tests
register `ReadKeepEntry`, `SetKeepPlace`, `KeepEntrySnapshot`,
`KeepPlaceAcceptance`, `KeepPlaceProblem` and each route error's exact data schema
as named common components, proving status-specific response bodies without a
second hand-authored schema. Future server error handling still needs independent
proof. Strict cross-field membership equality and exact counter increments are
parser invariants beyond structural OpenAPI metadata. Synthetic wire/OpenAPI
fixtures run only in GitHub Actions; no complete Keep journey or runtime privacy
acceptance is claimed.


## Opening a Region encounter

Related: #238.

`apiContract.experience.openRegionEncounter` declares POST
`/v1/experience/region/open` with strict `region-encounter-open.v1` JSON input.
This is an explicit idempotent Composer preparation **command**, not a read,
activation or map observation. The selected target is an exact Geography region
UUID with expected object/Geography revisions; an optional existing Composer
session carries its latest expected intent. ClientCapabilities are canonical.
Owner/epoch come from the authenticated scope, never the input. No Scene identity,
meaning/label/topic assertion, asset override, camera or playhead is accepted. The optional
`expectedEncounter:{assetId,assetRevision}` is solely a displayed-target expectation: it
never overrides canonical region selection or grants admission.
Future HTTP adapters require first-party Origin, current session and `X-KS-Scope`
guards, private/no-store responses and body/output ceilings. Private IDs stay in
the JSON body, never paths, general logs, cursors or diagnostic payloads.

The strict response binds the authorised universe/epoch and exact target echo to
an existing NavigationOutcome. Ready offers retain discovery relations and the
same decision identity, bounded chosen+two buffers and unique explanation units.
Exhaustion means no eligible content, leaving the region intact. Pending still
requires actual durable authorised work; this declaration creates none. Replay
preserves its original status. Root, Geography, object and session intent stamps
remain separate domains. Consumers must compare target/scope/command echoes and
fence stale or late responses; schemas cannot compare an initiating request for
them or establish current backend authority.

No controller, Composer consumer, metadata lookup, job, SQL or UI is installed.
Before implementation, Geography must resolve the actual own region/parents and
canonical topic+facet under the current personal root and active-owner fence,
refusing stale/foreign/unsupported/ambiguous targets and alias redirection.
Content must retrieve by admitted non-incidental parent topic AND exact facet
before its bounded limit, then independently recheck each immutable candidate.
Existing general discovery's global-prefix lanes are not that authority.
Experience must retain this actual region binding through its existing Tx1 →
pure Composer → Tx2 receipt/session/decision/offers lifecycle, repeating scope,
latest intent, region, Content/capability/Hide checks after waits. No network wait
belongs in a transaction or HTTP path. Same command/body retries once; another
body under its key conflicts. Live authority precedes receipt replay. A hash,
scene ID, descriptor or label never substitutes for these checks.

Offer preparation/metadata creates no exposure or Evidence. Open into the actual
foreground encounter uses the existing explicit offer activation and its current
scope/intent/TTL/Content checks. Only actual playback/reading observations supply
consumption evidence. Local selection, Close, camera travel and Back send no new
command or return contribution. Future “More in region” must explicitly retain
the constrained session intent; current navigation does not supply that seam.
Absent content, unsupported commands and offline states must remain honest; no
read enqueue, generation, supply request, bootstrap, visit growth or placeholder
encounter is implied. U04's authored content is design data, not a fixture to ship.

`RegionEncounterProblemSchema` is a finite strict RFC 9457 union using existing
catalogue codes and fixed metadata. Its bounded issues accept only declared field
tokens or `unknown`; dynamic capability keys, numeric segments and rejected values
must be masked, never echoed. No arbitrary detail/instance is permitted. The route
spec hook describes converter-produced error data directly as
`application/problem+json`; it is OpenAPI metadata, not an HTTP error serializer.
Global ProblemDetails and legacy open/activation stripping remain unchanged.

Wire/refinement and actual OpenAPI-generation fixtures run in GitHub Actions only.
They prove no established region, current target binding, runtime endpoint,
provider compatibility, browser/native journey or #238 completion. A later client
must preserve AccountScope disposal and its local exact camera/selection return,
accessible dialog/focus/keyboard and truthful unavailable states. U05 durable
per-account claim/disposition consumers remain separate unimplemented work. The new
wire declarations below do not replace those consumers; origin IDs, an Open receipt
and local memory cannot enforce cross-device uniqueness.


## Selective Clear

Related: #246.

`clear-exploration.v1` declares `apiContract.privacy.clearExploration` (POST
`/v1/privacy/clear-exploration`,202) and `readClearExplorationStatus` (read-only POST
`/v1/privacy/clear-exploration/status`,200). These strict JSON declarations install
no handler, deletion executor, durable operation receipt, queue or client flow.
No SQL number is allocated. First-party Origin, current session/`X-KS-Scope`,
active account authority and private/no-store responses remain mandatory for
both future adapters; these routes are not an unscoped authentication exception.
Parsed IDs, confirmation, receipts and hashes never confer authority.

A deliberate start supplies only version, commandId, expectedPrivacyEpoch and
`confirmation: clear-exploration-preserve-keep-and-social`. The future owner derives
account/universe, fences current authority before receipt lookup and atomically
accepts one operation, advances epoch exactly once, sets a live-read barrier,
revokes old sockets and enqueues IDs-only work. fromEpoch/toEpoch are positive
safe integers with toEpoch=fromEpoch+1. Input at the maximum epoch can be represented;
a new operation must refuse counter exhaustion without any effects, using fixed
CONFLICT. Busy live cleanup also refuses without effects. An immutable 202
acceptance records historical epochs/time/command, accepted operation and replay
delivery; it contains neither completion nor a current authorization scope.
Never construct an AccountScope from its toEpoch. Only the existing authenticated
session owner establishes current scope.

After accepted or unknown transport outcome, the future client synchronously
fences and purges the old AccountScope before awaiting session refresh. It retries
the exact original body/command only through a fresh current scope. A matching
account-lifetime receipt can replay after later epoch changes; a changed body
refuses COMMAND_KEY_REUSED, and a missing receipt plus stale expected epoch cannot
start a new operation. Historical receipt replay must neither rerun broad erasers
nor reveal surviving/replacement content. These are required backend/client
semantics, not proof established by wire validation.

Status uses a closed `latest` or exact `command` selector; its response echoes the
selector and CURRENT authenticated account/epoch. A recorded receipt must match
the command selector and cannot advance beyond that current epoch. `not_recorded`
is one serialized snapshot, not proof a delayed start cannot arrive. Latest
supports reload recovery without retaining old private scope caches/journals.
Recorded states distinguish pending coarse phases (`removing_live_data`,
`waiting_for_accounting`, `verifying_live_removal`), durable failed work with only
`temporarily_unavailable`/`completion_unverified`, and verified `completed_live`.
Failed does not claim rollback of partial deletion. No percent, counts, owner table
names, private item lists, arbitrary error text or ETA is public. Status is a read:
no enqueue, Evidence, activation, model or reconciliation call.

Later lifecycle owners must preserve exact Keep membership UUID/ref/revision/time
and full position/place CAS, Social friendships/settings and explicitly declared
conversation state, while deleting old action origins/exposures/history, Evidence,
Personal Context/Memory, Composer/planner and all Scene/Geography versions/jobs.
Keep is never a source for reconstructing cleared evidence or worlds. Current
full-delete/eraseUniverse behavior remains unchanged. No conversation store is
claimed implemented by this declaration. An account-owned durable receipt must
survive epoch changes; existing erasable personal receipts are insufficient.
A real selective-maintenance capability and lock-free live-read barrier are still
missing. Monotonic internal core_done must prevent old retries deleting fresh
new-epoch exploration after the barrier opens, even while old minimal accounting
liabilities remain pending. Durable Reasoning request/output/context redaction and
late-settlement suppression are prerequisites; unknown paid outcomes stay held,
never blindly resent/refunded or reconstructed. All mandatory controllable live
cleanup must be verified before completed_live; retained minimal usage accounting
is separate. No backup/provider/offline expiry period or removal guarantee is
invented. These implementation and real-journey prerequisites remain unallocated.

`PrivacyProblemSchema` is a strict local RFC 9457 family using existing catalogue
codes, fixed type/title/status and bounded schema-owned issue tokens or `unknown`.
Unknown field names/values and numeric paths cannot be echoed; no detail/instance
or current-state private payload is allowed. Global ProblemDetails and legacy
unknown-field stripping remain unchanged. The supported route.spec hook describes
converter-produced error data directly as application/problem+json, with exact
status-specific alternatives; it is not a mounted exception serializer. Real
OpenAPI tests assert named components, exact 202/200 POSTs and direct errors. Epoch
increments/receipt-selection invariants remain parser checks beyond structural
OpenAPI metadata. Synthetic wire tests run only in Actions; no completed privacy
operation, account deletion or runtime preservation is established here.


## Removing a Saved item

Related: #234, #246.

`keep-remove.v1` declares `apiContract.keep.remove`, POST `/v1/experience/keep/remove`,
with strict version/commandId/entry JSON. Entry is the actual Saved UUID plus immutable
asset/revision from an authorized Keep read. An asset ID, Save acknowledgement or local
resume is insufficient. No position, current membership override, force or Undo token is
accepted. Parsing is not authority; this declaration installs no endpoint or safer removal.
Legacy asset-keyed Unsave stays unchanged and retains its known remove/resave race.

A future adapter authenticates current session, Origin and `X-KS-Scope`, locks/rechecks
the current personal root/account before receipt lookup and keeps all responses private
and no-store. For a new command it must remove ONLY that exact current membership/ref.
Missing/replaced membership refuses with fixed KEEP_ENTRY_UNAVAILABLE; it neither removes
a later Save nor returns its identity/place. A corrected or withdrawn asset can still be
removed: removal requires current membership and account authority, not Content admission
or a playback grant. Place cascade and existing Unsave action/state/contribution semantics,
receipt, root revision and required pg-boss work must commit atomically. Do not bypass the
existing domain action effects with an isolated Saved-table delete. Removal creates no
consumption, playback, reading interval or invented Evidence.

The strict 200 acceptance repeats only the selected entry, scope, command, recorded time,
accepted operation and replay flag. It is historical: it does not assert current absence,
current place or permission to remove another membership. After current authority and exact
body/key matching, receipt replay MUST precede the now-deleted membership check; otherwise
an acknowledged removal could never replay. Replaying removal of A while a later membership
B exists returns only the original A acknowledgement and leaves B untouched. A different
body under the same key refuses COMMAND_KEY_REUSED. An old epoch never bypasses current
scope guards to recover a receipt, and later clear/account deletion may erase that receipt.
These are backend obligations, not invariants a wire parser can prove.

KeepRemovalProblemSchema is a closed 14-code RFC 9457 family using existing catalogue titles,
statuses and types. Only fixed schema-owned issue tokens or unknown are allowed; numeric
segments, received keys/values, arbitrary detail/instance, counts and replacement identity
are forbidden. Place-CAS stale/counter errors are excluded. Its supported OpenAPI hook
describes direct application/problem+json data; it is metadata, not an installed error
serializer. Existing Keep place/read schemas, global problems and legacy stripping stay
unchanged. Actions-only synthetic wire and actual generator tests cover declarations.
A backend receipt/locking implementation, mounted consumer migration and real two-device
remove/resave/unknown-ACK verification remain required before claiming ABA-safe removal.

## Listing Saved items

Related: #344, #234.

The existing GET `/v1/saved` gains an explicit `pagination=saved-page.v1` branch.
It requires `filter=all|reel|scroll` and string `limit=1..50`; `cursor` is optional
on the first page. No coercion/default is applied on the wire. The existing
empty/limit-only request and ID-only response remain compatible, including
unrelated legacy unknown-field stripping. Newly reserved paging fields cannot
silently downgrade a malformed page into the first legacy list. New callers
must explicitly parse `SavedPageResponseSchema` and bind its account/epoch,
filter, numeric limit and `requestCursor` to their initiating scope/request: a valid legacy 200
response from an older server is insufficient. `requestCursor` is absent on the
first page and must exactly echo the initiating opaque cursor on later pages;
a response from a different same-filter page must not enter this page cache.
A `more` token cannot equal that initiating token. This contract-only phase does
not implement paging, a cursor codec, kind filtering or complete library access.

A strict new page contains at most 50 unique current Saved memberships (one per
asset), their exact Saved UUID/immutable asset revision, actual Reel/Scroll kind,
saved time, current availability and allowlisted consumer metadata. Corrected
rows retain the original saved revision and name a different current revision;
withdrawn rows retain identity/kind but contain no metadata or replacement.
Never infer kind from a title or omit withdrawn rows because hydration is absent.
The list carries no position: current own places continue through the existing
exact Keep read, bounded client cache and four-read admission. Canonical opening,
exact Remove/grace/Undo, place CAS and unknown-command semantics are unchanged.
No peer position, seen marker, observation, exposure, activation, job, consumption
or provider work results from paging/filtering/detail inspection.

`consistency: live` deliberately makes no retained snapshot promise. Each page
rechecks current account/universe/epoch, memberships and shared Content
availability. `revision` is the personal catch-up watermark at this read, not a
Saved-only revision or shared Content snapshot. It may change between pages;
unrelated root/place/evidence changes do not invalidate traversal. Clients must
not merge pages as one immutable library. They can replace the visible page,
retain bounded cursor history and offer Refresh for changes; no total is given.
Account switch/logout/privacy reset synchronously purge cursors/history/pages
and fence every in-flight response. Old replies cannot repopulate another scope.

Ordering is full database-precision `saved_at DESC, asset_id ASC`, matching the
existing recent index. Equal timestamps use the stable asset UUID tie-breaker.
A future server encodes the exact last consumed database key; it never rebuilds
an anchor from a millisecond-truncated JavaScript Date or checks that the anchor
membership still exists. Deleting an anchor must allow continuation. Membership
references/times are immutable, and resave creates a new UUID/time. Concurrent
new/resaved entries follow their actual keys: those newer than the current
anchor are visible after Refresh, not secretly injected above the traversed
window. Current rows can disappear or change availability across pages. Static
collections larger than 100 must remain fully traversable. Live writes do not
promise a complete frozen inventory or exactly-once enumeration.

`more` means another server traversal window can be read, not a count or proof
that a matching row exists later. Bounded filtering may yield an empty page with
`more`; it must not claim an empty library. Only `end` terminates this traversal.
Kind filtering must use actual trusted Content kind through an allowed public
port or reviewed owned projection/index, before selecting output rows. It must
not filter only the newest 100. A bounded candidate implementation may inspect
at most 100 references per request plus one IDs-only lookahead; it advances only
past consumed candidates, never skips an unreturned matching row. No full-library
SQL/materialization, unbounded hydration loop or eager client fetch is allowed.
The client default remains 20 displayed rows, at most four concurrent real Keep
place reads, and bounded cursor/page retention. Efficient selective-kind indexing
remains an explicit later backend seam; no migration is included here.

`ksp1_` cursors have 43..1024 base64url characters after the prefix. Parsing proves
syntax only. A future server must authenticate **and keep confidential** the
private envelope, bound to purpose/world, account/universe, epoch, filter, limit,
full-precision key and a short expiry. It rechecks current authority before
consulting the token; a cursor grants no access. No positions, peer facts or
counts belong inside it. Tokens stay ephemeral: never persistent client storage,
general logs, traces, diagnostics or error values. GET queries carry only the
opaque token, never plaintext private IDs/anchors. A changed kind/limit starts a
fresh traversal. Deleted anchors and ordinary membership changes do not alone
make an otherwise valid live cursor stale.

The current API media grant adapter uses a per-instance random signing key that
rotates on restart. A **separate** Saved AEAD key can follow that lifecycle without
an environment secret or new table; this is a permitted future codec design, not
implemented encryption. The current deployment runs one API instance. Restart,
rotation, expiry, another instance, tampering or scope/filter/limit/purpose binding
failure must uniformly answer fixed 409 `SAVED_CURSOR_UNAVAILABLE`; the UI offers
Refresh and discards that traversal. No multi-instance portability or restart
continuity is promised. Domain/application code sees only an opaque codec port;
key creation stays outside personal transactions and is composed at the API seam.
Consumers still need full codec expiry/tamper/cross-binding/rotation tests.

All GET success and error responses must be private/no-store, selected before
query/body/auth parsing. Current session and `X-KS-Scope` guards remain mandatory;
a cursor never replaces them. `SavedListProblemSchema` declares 14 closed problem
codes and bounded schema-owned issue tokens; no rejected token/private value,
unknown key name, decoder exception, detail, instance or count can escape. Bad
wire syntax uses INVALID_REQUEST; syntactically valid unavailable tokens use the
same fixed cursor 409. The OpenAPI hook describes direct application/problem+json;
it installs no HTTP serializer/cache guard. Per-parameter GET metadata cannot
express all union correlations; the actual wire parser remains authoritative.

Synthetic schema/actual OpenAPI-generator fixtures run only in Actions. Real
PostgreSQL >100/equal-timestamp/deleted-anchor/resave/kind/withdrawal tests,
installed HTTP authority/private-error coverage, scoped client paging and the
disposable-account deployed journey remain required after this prerequisite is
accepted. This phase does not close #344 or full S01/S02/runtime acceptance.


## Region preview and formation presentation (contracts only)

Related: #357.

`apiContract.experience.previewRegionEncounter` declares read-only POST
`/v1/experience/region/preview`. `region-encounter-preview.v1` binds a fresh readId,
exact own-Geography selection and canonical capabilities to current own scope/root
watermark, Geography revision, observation time and one immutable consumer card.
Only asset/revision and ordinary kind/title/summary/language metadata travel. The read
creates **no offer, session, command receipt, exposure, Evidence, demand, job or model
call**. It provides no rendering/access authority. Missing approved canonical facet or
unsupported framing stays unavailable. A bounded incomplete candidate window uses
`selection_unavailable`; `no_eligible_content` requires genuine complete exhaustion.
Never broaden to generic discovery, guessed title/topic or authored design activity.

Legacy Region Open inputs/responses remain valid. A caller that displayed preview A
must send `expectedEncounter` and require the exact expectation/capabilities echo;
a bound ready response must choose that exact asset/revision. Current scope, readId,
selection, capabilities and nonregressive root/Geography checks belong to consumers:
no parser can compare an initiating request or prove current authority. Stale A must
refresh/refuse, never paint or open replacement B. Buffered offers still need the
actual canonical region constraint; foreground activation independently rechecks it.
Camera, focus, map return and genuine player/block offsets remain private AccountScope
state, absent from this wire and browser history. Close/Back/selection alone are reads
or local actions, never implicit Open. Offline/unavailable states retain the map.

`apiContract.formation` declares three private POSTs:
`/v1/universe/formation/read`, `/claim`, and `/acknowledge` under
`formation-presentation.v1`. These declarations install no backend, worker, storage,
recovery, eraser or UI. Root accepted delivery policy is freshness 300 seconds,
claim 30 seconds, full sequence 2400ms and max 8 target IDs; these are not formation
thresholds or consumption/learning measures. The fact contains only an already
committed transition/time/component stamps and bounded neutral creation labels,
truth framing, object/parent identities and revisions. No model proposal, support
refs, scores, source panel, geometry, seed or camera travels. Existing scene-core
schemas/identity/families/generators remain unchanged. Only an actual created planet
may select full planet beats; optional new-system beats require matching system and
star creations in that same fact. Existing systems skip them; system/region-only
facts use a final still. Hypothetical truth framing never silently becomes factual.
The later backend must verify actual Geography authority and all selected current
manifest/chunk targets before offering eligibility, without inventing projection.

A formation read returns at most one candidate, or none/unavailable/unsupported.
It echoes readId/selection/capabilities, scope/root and current Geography/Scene stamps.
It creates no claim, receipt, expiry cleanup, job or shown mark. Claimable freshness
is exactly 300 seconds from the original commit time, never renewed by reading.
Late/reconnect/backlog, already claimed or terminal facts render the existing map's
final state directly, without another story or invented shown acknowledgement.
Reduced motion retains exact targets/framing and uses a still/caption only.

Claim sends one commandId, transitionId and local attemptNonce. A later consumer must
atomically acquire at most one claim across devices under current personal root,
owner/epoch/Clear and projection gates, with receipt/root/required expiry work in the
same transaction. Claim is eligibility, **not shown**. Unknown acknowledgement retries
only that exact original body; never animate optimistically or mint a replacement
claim after reload. Immutable receipt and **current** eligibility are separate:
replay may retain an old `claimed` receipt while `current` is final/expired. Active
must name that exact claim and unchanged 30-second expiry. Neither replay nor syntax
proves a live server claim; the client also checks actual scope/expiry/foreground and
synchronously marks its one local attempt started before callbacks or remounts.
Expired or interrupted claims are never reissued for animation. No encounter is
interrupted and no background story or burst of old presentations is permitted.

Terminal command names exact transition/claim/attemptNonce and stable commandId.
`shown` follows an actually completed sequence or actually mounted reduced-motion
still/caption. Skip, leave, background or interruption sends `skipped` while the
original scope remains live; scope end stops and purges locally, never dispatches
under a replacement scope. Terminal receipt keeps the requested disposition separate
from an already terminal actual one: a delayed shown cannot overwrite an expiry skip.
No acknowledgement inserts a transition or contributes formation, learning, belief,
mastery, consumption or personal evidence. Retry preserves the original body/receipt.

Later consumers must enforce non-oracular current authority before lookup/replay,
private/no-store before auth/body parsing, first-party Origin/scope guards and finite
body/output limits. Closed problems reuse fixed existing catalogue codes; only static
schema path tokens or `unknown` are allowed, never values, numeric positions, private
IDs, dynamic capability keys, detail/instance text or provider messages. The OpenAPI
hook describes direct RFC 9457 error data only, not an installed error serializer.
Expiry/restart/final-delivery recovery needs finite indexed advancing continuations
committed before busy work, no status-read maintenance or second outbox, and concrete
full/selective-Clear ownership across epochs/queues. A delayed old claim/job/erasure
must not recreate cleared state or touch genuine new-epoch data. Those implementations,
0037/0038 allocation, semantic approvals, real supported formation, cross-device/
accessibility/browser/native journeys and #237/#238 completion remain separate gates.
Only Actions run the authored contract/refinement/OpenAPI suites; fixtures are not
actual claims, rendered worlds or runtime acceptance.


## Conversations and whole-content sharing

Related: #370, #241, #242.

`apiContract.conversations` declares nine private JSON POSTs under
`/v1/social/conversations/`: deliberate `start`, `inbox`, `read`, `history`, `changes`,
`send`, caller-only `mark-read`, `mute` and `leave`. A current accepted friend may start
one direct two-human conversation. Existing Friends/profile/invite/visibility/presence/visitor
contracts and their partial unmounted backend remain unchanged. These declarations mount
nothing. Group/thread invitations, content threads, snippets/anchors/block settings, scenarios,
rooms, typing, AI participants and Social sockets are separate phases. Never display authored
contacts, messages or availability as real activity. Missing features stay explicitly unavailable.

A future backend must enter the current personal root/account/epoch gates, then reuse the
existing private pair aggregate as its **sole** shared locking authority for direct conversation
work. The conversation has a separate opaque public ID; no private pair root or revision travels.
Never acquire a pair root and then a second conversation root. Current accepted pair lineage,
participation, block/revocation and Content access precede both current reads and historical
receipt lookup. Lost access is coarse unavailable, with no private peer cause. Own participation
has an immutable ID/revision; leave/withdrawal ends it, and later re-friending cannot silently
restore the old conversation or command authority. Parsing does not prove any gate or lock.

Messages have stable server-assigned sequence/UUID identity. A separate durable **visible**
change sequence orders creation/redaction; redacting a body updates the original bubble rather
than moving it. A message ID cannot change its original sequence or share one with a different
ID. Peer read/mute/presence/private transitions never advance a caller-visible counter, change
position or inbox order. Inbox order is last visible message commit time DESC, conversation ID
ASC. Lists contain only actual authorized conversations, not suggestions or activity counts.
Only the caller's read-through and notification preference travel; no peer seen marker, current
branch, interests, playback or reading position is permitted. Human author labels are actual public
person references. Deleted private bodies/attachments become minimal unavailable markers without
old author/text. Shared public Content and another person's independent messages remain theirs.

Initial snapshot plus catch-up position must be captured atomically under the aggregate root.
Each purpose has a different opaque confidential cursor (`kci1_`, `kch1_`, `kcc1_`), bound to world,
caller/account/epoch, membership/authority lineage, purpose, limit and finite traversal ceiling.
Each request selects limit 1..50 and returns at most that many items; each response echoes its readId, actual scope, limit and initiating
cursor where applicable. Consumers compare these to the actual request/scope and reject
regressive watermarks. Strict schemas check unique ordered bubbles, increasing bounded changes,
finite-window completion and nonlooping continuations; they cannot authenticate a cursor or
compare it to a separate request. Invalid/expired/rotated cursor means explicit refresh_required,
never an implicit first page. Empty caught-up is a valid live result, not a claim that future
messages cannot arrive. Each captured change window ends even under continuous new writes.
History has its own cursor and never replaces the active catch-up cursor. Retention gaps require
refresh; do not invent missing changes. Current privacy/access gates still apply on every page.

Durable send accepts plain text<=2000 UTF-16 units or a whole exact asset/revision with an optional
note. No snippet/player locator enters this phase. Commands keep one stable commandId and exact
original body after an unknown outcome, including a later 401/403 refusal that cannot reconcile the
first attempt. Never mint a replacement or automatically reissue an ambiguous command. Receipts
repeat only committed IDs/order and exact content identity, not message text, current membership,
delivery/seen assertions or access grants. Same canonical body replays one outcome; a changed body
under that key is COMMAND_KEY_REUSED. Receipt, message/domain effects and required pg-boss work
must commit in one transaction. Disposable ID-only NOTIFY hints cannot acknowledge a send; missed
hints repair through authorized bounded HTTP catch-up/foreground refresh. No second outbox,
socket command path or model/provider work is introduced. Report/abuse handling remains future
implementation, not a fabricated successful moderation action.

`apiContract.contentShares` declares four JSON POSTs under `/v1/social/content-shares/`:
`create`, `revoke`, current-own `read`, and sensitive `resolve`. Exact references never silently
replace a corrected revision. A corrected projection names both the original and a different
current revision of that same asset; a user deliberately chooses a new canonical Open, then the
real activation/recorder path independently establishes any encounter. Received cards, message
reads, sharing, link resolution, copy and platform intent create no consumption Evidence, learning,
interest or formation. Confirmed in-app send is distinct from sheet-open/cancel, copied link or
external delivery, which cannot be inferred.

Audience is explicit: `public_metadata` or one authorized direct conversation. Public resolution
returns the same current public Content allowlist for **all** callers, without sender, conversation,
relationship, private body, source panel, token, media URL or playback grant. It never consults a
peer-private block to change that public projection. Public audience cannot publish a private asset.
Private possession alone grants nothing; current member/pair/block/source checks are mandatory.
Unknown/expired/revoked/withdrawn/private-denied landing has one neutral shape, no title/poster,
sender or reason. No link automatically joins a conversation/thread. Current Content correction,
withdrawal or access change cannot be bypassed by a historical message or creation receipt.

A `kssh_` bearer token is delivered once, separately from the immutable acceptance; replay can
recover the same shareId but never another token. Lost delivery requires deliberate revoke of that
link then a new command. Original expiry is captured once, finite, later enforced from server time;
no read/replay renews it. Concrete TTL/key/retention policies require later backend review. Fresh
same-account current-resource lookup by shareId or original creation command can recover a retained
own link after Clear without replaying the old-epoch command or exposing its token. Private reads
still require current relevant authority. The dedicated future `/s/:token` landing must isolate
proxy/referrer/OpenGraph handling; sensitive API resolution uses JSON, not a general API path/query.
No token in logs, ordinary receipts, notices, errors or persistent client storage. Metadata/card
caches purge on scope end and revocation, and bounded foreground reads recover missed invalidations.
No public response/OG metadata may reveal a private link's existence or data.

Clear preserves account-lifetime Social membership/messages/shares but fences old-epoch commands
and purges scoped clients/sockets. Full account deletion separately removes authored private
message bodies/attachments, leaves minimal continuity markers and revokes private links; it must
not delete other people's independent messages, retain erased text in summaries or promise recall
of external copies/backups. Runtime erasers/account deletion are not implemented by this wire.
All endpoints require current session/Origin/scope and private/no-store before parsing, except a
future explicitly reviewed unscoped public landing/resolution composition; no current guard exemption
is added here. The closed Social problem family reuses existing catalogue statuses/titles and only
static issue tokens or unknown; it rejects raw values, numeric/dynamic paths, detail/instance and
private cause/counter fields. OpenAPI describes direct RFC 9457 data, not a mounted serializer.

Authored strict schema/privacy/cursor/order/replay/first-secret-delivery and actual OpenAPI tests run
only in Actions. SQL/lock/concurrency/recovery/erasure, real HTTP/cache/membership/content authority,
scoped client unknown-retry/purge, two-account share/reconnect/revocation and independent real
encounter evidence remain mandatory follow-up work. This prerequisite does not finish 241/242 or
claim mounted Social, delivery, public publication, media access or runtime acceptance.

## Pausing personal recording

Related: #376.

`recording-policy.v1` declares two scoped private JSON POSTs in `apiContract.recording`:
`/v1/privacy/recording/read` and `/set`. They are declarations only: no policy table,
recording gate, API controller, worker, recorder behavior or account mutation is installed.
Existing selective Clear schemas and contract bindings are unchanged. Export and account
deletion remain separate unimplemented lifecycle work; this adds no authentication exception.

Pause stops new durable passive encounter evidence and NEW derived personal growth,
including growth inferred from explicit actions. Explicitly requested commands still need
their own necessary records. Existing history, Keep and current universe remain visible.
Recording generation is distinct from privacy epoch, starts at 1/on, is bounded by 2147483647
and never wraps or resets across Clear. An actual on/off transition increments it once;
an accepted no-op retains it. Clear preserves the preference and generation.
Because only real boolean toggles increment from 1/on, odd generations are on and even
generations are off. Current policy and receipt final-state schemas enforce that invariant.

Set requires one stable commandId, expected privacy epoch/generation and desired boolean on.
The receipt's two-component operation is `privacy.recording-set`; outcome-version storage
is a separate infrastructure concern. Unknown transport outcomes retain the exact original
body/ID; never mint a replacement or silently queue an offline toggle. The historical receipt
records its requested epoch, from/to generation, desired on, changed flag and server time.
It is not the current policy. After current authenticated owner/root/epoch/Clear-barrier
checks, replay returns that receipt without retoggling, renewing or undoing a newer policy.

Pure read echoes readId and exact current/command target with the current account/epoch,
root revision and on/generation. A command target separately says recorded/not_recorded;
only recorded contains its matching immutable receipt. At equal generations the receipt
must match current on; older receipts may differ. A recorded old on receipt cannot authorize
collection while the current snapshot is paused. A not_recorded snapshot does not prove
an in-flight command cannot still arrive. Reads create no work or repair effects. Consumers
must correlate actual scope/readId/target and reject stale generations/root watermarks;
schema validation alone cannot authenticate a request or compare another response.

`observation-batch.v2` adds the separate declaration
`POST /v1/observations/recording-batch` (`apiContract.observations.submitRecording`).
Its strict input requires version and recordingGeneration plus the original bounded event
shapes/instrumentationVersion, with the complete encoded batch capped at 49152 bytes.
No generation is optional. Malformed new input cannot downgrade into old input. The existing
unversioned `/v1/observations/batch` input/output schemas and route remain unchanged.
The separate new route prevents today's mounted old controller from parsing and then
silently ignoring a new generation field during a contracts-only release.

The FOLLOWING backend must allow old unversioned batches ONLY in initial generation 1/on.
After the first actual recording toggle that legacy wire is permanently refused with
`RECORDING_GENERATION_REQUIRED`, including after resume; no legacy backlog may enter a new
generation. Do not activate Pause until this guard covers the normal legacy controller,
every delayed projection/reconciliation path, personal growth preparation/dispatch and
final application. A mixed-version writer that ignores the generation must fail closed.

The new intake response echoes submitted generation separately from current generation,
scope and root revision. `processed` has exactly counted ordered final event results,
and requires equal current/submitted odd (on) generations; it proves intake, never qualification
or learning. `not_recorded` has only recording_paused/recording_generation_stale and no
partial accepted results. Both are final for that exact batch. Consumers compare ordered
event IDs for processed replies; remove refused events rather than relabelling/retrying
them under a new generation. Missing authority/epoch/validation remains a private problem.
The recording_paused branch requires an even current generation; requests may submit
either parity so paused/stale batches can receive their final refusal.

Pre-pause delayed work cannot apply after resume merely because on is true again.
Resume starts fresh recording segments; paused/stale offline buffers never acquire a new
generation. Client collection stops under pause/unknown scope, but no scope-wide suspension
or history reset is implied. Already irreversibly authorized external effects may still
return/bill: preserve accounting and prevent stale personal application, never invent a refund.
No model/provider permission follows this policy or its schemas.

Closed recording problems expose fixed catalogue title/status/type and bounded static issue
tokens only. No event values, dynamic/numeric paths, generation counters, detail/instance,
private causes or operation body appears in errors. OpenAPI describes direct RFC 9457 data,
not a mounted serializer/cache/Origin/auth guard. Authored synthetic schema/OpenAPI fixtures
run in Actions only. Durable state/locks/unknown replay, real mixed-version intake/worker
fences, scoped client callbacks/offline buffers, deployed pause/resume and preservation
remain mandatory following work; this contract prerequisite does not finish #246.

## Friends roster pages

Related: #378, #377.

`friend-pages.v2` declares `apiContract.friendPages.friends` at private JSON POST
`/v1/social/friends/page` and `.requests` at `/v1/social/requests/page`. These are
pure read declarations only: no controller, list index, cursor codec, maintenance,
client drain, friendship, invitation or runtime journey is installed. Existing
`sharing.v1` schemas/tests and `/friends/read` / `/requests/read` declarations are
unchanged, including their nonempty continuation rule. Unsupported old routes
remain unavailable; malformed new input never downgrades to an old route/version.

`ReadFriendsPage` takes exact version, UUID `requestId`, filter `friends|blocked`,
integer limit 1..50 and optional canonical `SharingListCursor`; `ReadFriendRequestsPage`
uses `incoming|outgoing`. The cursor's filter must match the request. Request IDs
correlate reads, never command effects or permissions. Scope/cursor syntax is the
existing canonical schema, with no copied ID, pair, cursor or scope definitions.
Owner and current epoch come from authenticated authority, never a cursor grant.

`FriendsPage` / `FriendRequestsPage` echo version/requestId, current own scope,
filter and the public `snapshotRevision`, with at most 50 unique matching canonical
`FriendPairView` items and optional `next`. Response continuations bind that same
scope/filter/head. Empty items WITH next means the bounded scan examined candidates
without returning a currently eligible row and has another finite scan window.
It never means an empty roster or traversal end. Only no next exhausts the captured
traversal. Empty items without next is valid exhaustion. There are no totals,
private pair roots/revisions, peer epochs, raw scan anchors, counts, progress or
hidden peer causes. Canonical caller-visible pair views retain their existing
semantics; presence/expiry/private transitions never advance the public list head.

The future backend must authenticate and keep confidential the opaque cursor,
binding protocol/purpose/world, actual owner/universe/epoch, filter, public head,
requested limit, advancing anchor, captured finite ceiling and expiry. Cursor
syntax cannot establish authenticity or authority. Current eligibility may remove
inactive/inaccessible candidates; reads must not falsely terminate after an empty
bounded candidate window or run unbounded scans to manufacture a nonempty page.
Stable public ordering, a finite per-read candidate budget/lookahead and real
anchor advancement remain backend responsibilities. Private decline/block,
internal pair revision, peer epoch and presence changes must not leak through a
head, cursor refusal or data shape. Live profile/eligibility hydration must not
introduce public-head fanout for private transitions.

Consumers compare the response with the initiating requestId, actual AccountScope,
filter and captured public head; enforce returned items <=requested limit; reject
old/out-of-order responses, scope changes, repeated tokens and nonadvancing chains;
and purge scoped pages/cursors on logout, account switch or Clear. Empty+next may
show an explicit further-scan control, never a fabricated empty-state message or an
automatic unbounded drain. A schema cannot compare two HTTP messages or decode a
cursor. A continuing token does not prove a visible friend exists later.

Both new routes reuse the unchanged closed Social RFC 9457 problem family through
its existing supported metadata hook. New input field paths absent from that
allowlist (`requestId`, `filter`) must map to `unknown`; never echo dynamic keys,
values, tokens or numeric indices. OpenAPI describes direct application/problem+json,
not installed exception handling. Current session/Origin/`X-KS-Scope`, private/no-store
before body/auth parsing and bounded output are mandatory in future adapters.

`friend-pages.test.ts` and additive actual OpenAPI-generator assertions contain
synthetic contract fixtures only, run in Actions. Current database authority,
finite scan/token security, installed HTTP, scoped UI/client pagination and a real
two-account Friends journey remain required after this declaration prerequisite.

## Recording generation on commands

Related: #381.

Eight original command schemas reserve optional `recordingGeneration` using the
existing bounded integer schema (1..2147483647): ApplyAction, DirectActivate,
ActivateOffer, OpenDiscovery, OpenRevisit, Navigate, RegionEncounterOpen and
RemoveKeepEntry.
The field has no default, coercion or transform. A supplied malformed value,
including an own property whose value is undefined, is refused; it must never be
stripped through a legacy object or union fallback into an omitted legacy field.
Omission preserves the literal old body, including unrelated legacy unknown-field
stripping. New branches retain strictness. Legacy DirectOpen expressly forbids
this reserved field, including own undefined, so a mixed command cannot downgrade
into a nonevidence direct open. Success response schemas and route bindings stay unchanged.

This is a declaration prerequisite only. The following backend must distinguish
necessary requested effects from permission for NEW personal growth. A missing
field can be growth-eligible only at actual initial generation 1/on; after the first
real toggle, absence never inherits resumed current generation. A supplied stale
or off generation still allows necessary authorized action/navigation state and
receipts but remains permanently growth-ineligible for that intent. Schema
acceptance of an even generation is deliberate and grants no recording authority.
The original supplied field must survive validation into the future receipt's
canonical request hash. Omitted old bodies keep their original hash semantics;
never insert a generation default before hashing or retry with a different body.

Two-transaction preparation/navigation carries the ORIGINAL generation from Tx1
through Tx2 and rechecks current on/generation after personal-root waits; do not
stamp whatever resumed generation is current at commit. Horizontal/return growth
requires the original intent AND its activation to be eligible under that same
current generation. Later activation, reconciliation or an offline retry cannot
relabel an old or paused intent as fresh growth. Necessary actions, Save/Like/Hide
state, navigation, playback and Keep remain usable under their normal authority.
Direct opens, media grants, presentation and Keep themselves remain nonevidence.
These semantics need the separately allocated backend/worker/client consumers.

Saved-list removal also carries its original generation so a genuinely eligible
negative decision can correct its own previously committed Save credit. Removal
still requires the exact Saved membership and remains usable while paused or stale;
it creates no encounter, positive credit or passive evidence. A missing field after
the first toggle remains necessary-only. Its historical acknowledgement does not
echo a generation or claim current recording policy. Keep reads and position-only
writes gain no field or growth authority. Consumers must preserve the original
removal body through retries and canonical receipt hashing, never stamp server-current
generation onto an old command.

The region and Keep-removal error allowlists add only the static `recordingGeneration` issue token,
with no rejected values, dynamic paths or new error catalogue. Dedicated synthetic
fixtures cover all eight absent/valid/max/even/malformed/explicit-undefined cases,
wrong originals and actual union fallback. All existing assertions are retained.
Automated suites run only in Actions; no runtime Pause, current eligibility,
receipt-hash implementation or deployed journey is established by declarations.


## Sending recovery and public previews

Related: #242.

The original 13 direct-conversation/content-share operations above keep their schemas and
refinements. Two additive declarations provide prerequisites for the later vertical implementation:

- `conversations.readOwnSend`: `POST /v1/social/conversations/send/read` accepts a fresh `readId`,
  the current exact `DirectConversationRef`, and `{kind:'command',commandId}` selector. A current
  own-resource result repeats that selector and current account/epoch scope. `accepted` contains
  only original message UUID/sequence/time and text-kind or exact content identity; no body,
  note, historical acceptance, token, replay flag or delivery assertion. `unavailable` has no
  conversation or private cause and never proves not-sent. Preserve the original pending command
  and its unknown outcome; do not mint another UUID or infer permission to resend. After Clear,
  this is a fresh owned-resource lookup, not re-authorisation of the old-epoch command. Actual
  current own/pair/block/member/incarnation/source gates must precede lookup.
- `publicContentShares.preview`: `POST /s/preview` reuses the exact `content-share.v1` JSON
  `readId`/sensitive-token input. Its separate schema can return only `unavailable` or bounded
  `public_metadata`, including an explicit same-asset correction. It rejects the full private
  resolver's `conversation` variant, even for signed-in members. Cookies, private audience,
  sender or peer-private block cannot widen/change this public-only projection. This is outside
  private `/v1`, without widening `socialPost` or adding an unscoped-v1 wildcard.

`ownConversationSendForRead` checks every initiating read/selector and current scope/participation
field; UUID identity is compared case-insensitively without rewriting bodies.
`publicContentSharePreviewForRead` checks read correlation while reparsing only the public union.
Both are pure syntax/correlation helpers. Their explicit current inputs are not authenticated by
this package; no lookup, lock, session, Origin check or permission is installed. A mismatch returns
`undefined`, never a historical fallback or replacement command. The new JSON surfaces reject
accessors without evaluating getters, own undefined/symbol/nonenumerable properties, non-JSON
prototypes, cycles and coercion/defaults. A fixed 512-node/depth 12 precheck bounds these small shapes.

The public error family has exactly eight fixed catalogue codes: invalid request, Origin refusal,
payload too large, unsupported media type, unprocessable request, rate limit, unavailable service
and internal failure. No auth/scope/pair/block-existence channel is exposed. Issue paths contain
only `version`, `readId`, `token` or `unknown` (max 8 segments/max 32 issues); dynamic keys, values,
numeric paths, raw errors, `detail` and `instance` are forbidden. Future HTTP adapters must project
raw parser issues into this allowlist and install the direct RFC 9457 serializer. Contract parsing
alone does not sanitize parser exceptions for logging. OpenAPI describes the strict public error
schemas and the original private Social family separately.

The dedicated future `GET /s/:token` HTML landing is the explicit token-in-URL exception. It must
isolate proxy/access logs, referrers, history, OpenGraph and redirects. Tokens stay out of ordinary
API URLs/query strings, receipts, diagnostics, notices and error bodies; the JSON preview carries
its token only in its request body. No GET landing or cookie/cache/Origin policy is mounted here.
No preview grants media, joins a conversation, creates a recipient encounter or supplies personal
Evidence. Content correction/withdrawal and real canonical recipient Open still require fresh
application authority.

Fixtures preserve the original 13 declaration assertions and add exact operation inventories,
strict public/private injection, unknown-send ambiguity, scope/incarnation/read correlation,
getter/secret canaries and converter-produced OpenAPI/problem metadata. Behavioral suites run
only in Actions. No consumer, schema migration, lifecycle registry compatibility, export/deletion,
shared-data policy, runtime deployment or account data mutation is implemented by these additions.

## Conversations and share links, as mounted (D-042)

Related: #242.

The declarations above are now served. Changes made with that slice:

- `socket.ts`: `SCOPE_KINDS` is `universe` and `inbox`. The inbox scope is named by the caller's own universe ID.
- `conversations.ts`: the inbox, history and changes cursor patterns accept 22 to 1024 characters, because the
  server's cursors are short keyset tokens. The inbox summary, the snapshot and the changes page carry an optional
  `ended: true` when the conversation is closed.
- `content-shares.ts`: new `contentShares.list` (`POST /v1/social/content-shares/list`) returns the caller's live
  links (at most 50: share ID, target, audience, creation and expiry time, content projection). It never returns a
  token; the token is delivered once by `create`.
- `openapi.test.ts` counts `list` as an additive declaration.

## Content threads and snippets (#243, D-046)

`threads.ts` declares `content-thread.v1`: `apiContract.threads` has ten private JSON POSTs under `/v1/social/threads/`
(`create`, `read`, `history`, `changes`, `send`, `respond`, `mark-read`, `leave`, `inbox`, `snippets/open`).

- A thread is named by `ContentThreadRef` (thread ID, membership ID, membership revision), like a conversation.
- `CreateContentThread` takes one to eight distinct friend person IDs, the exact root revision and an optional plain name.
- A snippet anchor is one of `reel_range {startMs, endMs}`, `scroll_passage {blockId, start, end, quoteHash}` or
  `scroll_block {blockId, blockType, blockVersion, settings?}`. Settings are a scroll-model snapshot plus an explicit
  `confirmPersonal` flag; nothing else is accepted. Unknown fields are refused everywhere.
- A `ContentThreadView` is `unavailable`, `invitation` (who invited and the root, no messages) or `ready` (messages,
  people, episodes with the caller's own `visited`, own read state, catch-up cursor). No schema has a field for another
  member's position, current episode or seen marker; `threads.test.ts` checks that unknown fields are refused.
- A snippet message carries a card: the exact target, the anchor in words (range, quote, label, settings description) and the
  content status (`available`, `corrected`, `unavailable`). Quote and settings are omitted when the content is unavailable.
