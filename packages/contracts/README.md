# @knowscroll/contracts

JSON-native wire contracts shared by the API and its clients (blueprint §6): Zod schemas, oRPC
contract routes, public IDs and the stable problem-code catalogue. Nothing here runs on only one
side, and nothing here transforms data: parse first, then convert in the receiving adapter.

| File | Contents |
|---|---|
| `src/problems.ts` | `problemCatalogue` (code → HTTP status, fixed title), RFC 9457 `ProblemDetailsSchema`, `problemDetails()` |
| `src/health.ts` | `GET /health` response and contract |
| `src/identity.ts` | `/auth/*` sign-in and session routes, the link and session token shapes, the session cookie names (D-022) |
| `src/router.ts` | `apiContract`: every HTTP route the API serves |
| `src/content.ts` | Re-export of the canonical `ScrollDocument` (`scroll-document.v1`) and `ClientCapabilities` from `@knowscroll/scroll-model`; never copied, and never its internal provenance or producer entries |
| `src/experience.ts` | `POST /v1/actions`, `GET /v1/saved`, and the exposure routes: `POST /v1/experience/open`, `POST /v1/experience/activate`, `GET /v1/experience/exposures/{id}/document` |
| `src/navigation.ts` | Composer session discovery, `POST /v1/experience/navigate`, semantic intents, prepared public offers, ready/pending/exhausted receipt outcomes and offer activation |
| `src/supply.ts` | Declaration-only topic/format-variant requests, immutable acceptance/cancel receipts and current private request status; not routed by `apiContract` (#239 prerequisite) |
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

These schemas are **not routed or implemented** and do not complete #239. Series-next/related
commissioning needs a separate Content-owned admitted future-slot/move declaration and usable
consumer-facing revision; current links point to admitted assets, so no future Part or pending
target is invented here. E07's bounded private request list and explicit retry on the same request
ID need separate future declarations. Such retry must use a fresh retry command ID and recheck
authority, budget, fences and attempt ledger; replay/poll never implicitly retries production.
There is no Supply/Planner/Cartographer paid allowance in this prerequisite; D-024's #232 allowance
and owner-only Reel script approvals are unchanged. No backend, UI, queue or runtime acceptance is
claimed by these declarations.

Rules:

- A problem code never changes meaning; a new meaning gets a new code. Codes double as
  `reasonCode` in diagnostics.
- Job payloads, model outputs and internal projections are backend-local and never live here.
- Allowed imports: `zod`, `@orpc/contract` and the public entry of `@knowscroll/scroll-model`
  only (enforced by dependency-cruiser, `contracts-are-wire-only`).
- `src/openapi.test.ts` covers every route, direct/Composer unions and RFC 9457 errors.
- `src/navigation.test.ts` covers compatibility, intent fencing, bounded public metadata, distinct
  pending/exhausted states and downgrade refusal. Automated suites run in GitHub Actions only.
- `src/supply.test.ts` covers topic/variant branches, bounded input, real-reference shapes, immutable
  receipts versus current status, cancellation and strict refusal of private/internal fields. It
  establishes wire validation only, never actual admission or database authority.

Build: `tsc -p tsconfig.build.json` → `dist/`. Inside the workspace, TypeScript, Vitest and
dependency-cruiser read the sources through the `@knowscroll/source` export condition
(`docs/v2/engineering/workspace.md`).
