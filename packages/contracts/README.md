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

Rules:

- A problem code never changes meaning; a new meaning gets a new code. Codes double as
  `reasonCode` in diagnostics.
- Job payloads, model outputs and internal projections are backend-local and never live here.
- Allowed imports: `zod`, `@orpc/contract` and the public entry of `@knowscroll/scroll-model`
  only (enforced by dependency-cruiser, `contracts-are-wire-only`).
- `src/openapi.test.ts` covers every route, direct/Composer unions and RFC 9457 errors.
- `src/navigation.test.ts` covers compatibility, intent fencing, bounded public metadata, distinct
  pending/exhausted states and downgrade refusal. Automated suites run in GitHub Actions only.

Build: `tsc -p tsconfig.build.json` → `dist/`. Inside the workspace, TypeScript, Vitest and
dependency-cruiser read the sources through the `@knowscroll/source` export condition
(`docs/v2/engineering/workspace.md`).
