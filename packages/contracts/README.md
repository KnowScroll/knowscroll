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
| `src/router.ts` | `apiContract`: every HTTP route the API serves |
| `src/content.ts` | Re-export of the canonical `ScrollDocument` (`scroll-document.v1`) and `ClientCapabilities` from `@knowscroll/scroll-model`; never copied, and never its internal provenance or producer entries |
| `src/experience.ts` | `POST /v1/actions`, `GET /v1/saved`, and the exposure routes: `POST /v1/experience/open`, `POST /v1/experience/activate`, `GET /v1/experience/exposures/{id}/document` |
| `src/navigation.ts` | Composer session discovery, `POST /v1/experience/navigate`, semantic intents, prepared public offers, ready/pending/exhausted receipt outcomes and offer activation |
| `src/supply.ts` | Declaration-only topic/format-variant requests, immutable acceptance/cancel receipts and current private request status; topic/variant HTTP declarations in `apiContract.supply` (#239 prerequisite; adapters pending) |
| `src/geography.ts` | Declaration-only established geography pages, retained routes/aliases and typed applied universe deltas; not routed by `apiContract` (#237/#238 prerequisite) |
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
`POST /v1/content/requests/cancel` (immutable cancellation outcome). Both commands use HTTP200,
including exact replays; acceptance is distinct from ready and never promises paid work. Cancel
uses only its body request ID, avoiding competing path/body identities. Status GET has no request
body and never creates demand, retries production or activates an encounter. The future adapter
must apply the existing first-party origin/session/AccountScope guards and map typed refusals to
fixed RFC9457 problems; it must not disclose another person's request existence. These are HTTP
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

## Geography wire prerequisite (#237/#238)

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
Pages allow at most100 objects,100 routes and100 retained aliases. A continuation binds universe,
epoch, selection, geography revision and last object ID; the server validates it, pages in stable
ID order, and refuses an expired revision. Endpoints may name objects on other pages. A relationship
overflow must fail with `limit`, never silently truncate relationships or assert completeness.
No cursor or public ID grants permission. Friend/visitor projections require later sharing contracts.

`UniverseDeltaSchema` declares one atomic **already applied public effect**, with base/current
revisions, immutable transition ID and at most32 typed operations: `create_system`, `establish_star`,
`form_planet`, `add_region`, `connect_route`, `revise_label`, `set_activity`, `withdraw_relation`.
Effect revisions equal the commit revision; new identities retain that transition as their origin.
Label/activity updates cannot replace origin identity. Relation withdrawal retains its ID/endpoints
in subsequent snapshots; aliases retain old identities after a reviewed correction. Merge/split
proposal and alias-creation mechanics remain backend-local and need a future typed delta extension
before incremental alias updates; clients refetch snapshots rather than inventing such operations.
There is no arbitrary JSON patch, client formation command, eligibility override, model proposal,
private evidence, source, score, prompt, provider or validation-receipt payload on this wire.

`ReadUniverseDeltasSchema` and `UniverseDeltasSchema` declare read-only catch-up, at most10 deltas
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

## Scene HTTP prerequisite (#238)

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
