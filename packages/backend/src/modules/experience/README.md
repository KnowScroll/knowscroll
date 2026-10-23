# modules/experience

Owns: `experience.saved_items`, `experience.actions` (migration `0004_experience_actions`) and
`experience.exposures` (migration `0011_experience_exposures`).

| Operation | Route | Authority, effects, failure |
|---|---|---|
| `applyAction(authority, {commandId, kind, target})` | `POST /v1/actions` | Caller's account + universe at its privacy epoch, rechecked under the personal lock. One transaction: receipt lookup (replay / `COMMAND_KEY_REUSED` for a reused key, a receipt from before a privacy reset or a retired outcome shape / 503 for a receipt written by a newer release) → asset admitted at `assetRevision` (`ASSET_NOT_FOUND` 404 / `ASSET_REVISION_STALE` 409) → receipt → saved-state change (`decideActionEffect`) → action row → `evidence.apply-action` job → if the saved state changed, universe revision advanced and notified (the command's own watermark, returned as `revision`; a no-op save returns the current revision and notifies nothing) → outcome. All or nothing; refusals write nothing. |
| `listSaved(authority, limit)` | `GET /v1/saved` | Rechecks the universe (no lock) and reads ≤ 100 items newest first, with the universe revision they were read at. |
| `openExposure(authority, {commandId, target: {kind: 'scroll', assetId}, origin, capabilities})` | `POST /v1/experience/open` | Opens an admitted Scroll: creates the **exposure**, the lineage root of one encounter (exposure ID, the asset's current revision, origin, and the capabilities the client declared). One transaction under the personal lock with a command receipt (D-016): identical replay returns the stored outcome (`replayed: true`); another request under the key → `COMMAND_KEY_REUSED` (422); an asset that is missing, withdrawn, not a Scroll or without a stored revision → `ASSET_NOT_FOUND` (404) with **no** receipt (retryable). Opening is not consumption. |
| `activateExposure(authority, {commandId, exposureId})` | `POST /v1/experience/activate` | The article became the active reading surface. Under the lock, with a receipt: sets `activated_at` once (`decideActivation`: an active exposure keeps its original time, whatever command asks); an unknown or another person's exposure → `NOT_FOUND` (indistinguishable). Observations are accepted only for an activated exposure. |
| `readExposureDocument(authority, exposureId)` | `GET /v1/experience/exposures/{id}/document` | Rechecks the universe (no lock), reads the exposure, and asks content to render its immutable revision for the capabilities it declared (`degradedEssential` lists essential blocks shown only as fallback text). Only the consumer document: never provenance. `UNPROCESSABLE_REQUEST` when the declared capabilities cannot render it at all. |
| `ReadActionForEvidence`, `ReadExposureForEvidence` (tokens `READ_ACTION_FOR_EVIDENCE`, `READ_EXPOSURE_FOR_EVIDENCE`) | evidence | Read ports inside the evidence use case's own locked scope: one action; one exposure's lineage (revision, activation time, epoch). |

Domain rules (`domain/`, tested): Save/Unsave results depend only on the current state and the
action (`actions.ts`); activation is idempotent and never moves (`exposures.ts`).

Jobs: enqueues `evidence.apply-action` (payload `{v, universeId, privacyEpoch, actionId}`). Open and
activate enqueue nothing and send no hint: they change nothing a client reads (the evidence commit
does, later). Lock order: personal root only. Erasure: `saved_items`, `actions` and `exposures` per
universe (`adapters/erasure.ts`); saved items survive "clear exploration history" (blueprint §19), and
exposures do not (they root encounter evidence).

Worked operation: `POST /v1/actions {commandId C, kind: save, target: {assetId A, assetRevision 1}}`
→ 200 `{saved: true, changed: true, replayed: false, actionId X}`; the same request again → the
same body with `replayed: true` and no new rows or jobs; `kind: unsave` with C → 422.
`POST /v1/experience/open {commandId O, target: {kind: 'scroll', assetId S}, origin: {kind: 'direct'},
capabilities}` → 200 `{exposureId E, assetRevision 1, replayed: false}`; again → the same with
`replayed: true`; `GET …/exposures/E/document` → the negotiated document; `POST …/activate {commandId
V, exposureId E}` → `{activatedAt}`.

S2.4 adds `target.kind: reel` to the existing open/activate lineage. Opening and grant renewal create no
consumption evidence; an exposure remains bound to its immutable admitted revision. Scroll document
rendering stays Scroll-only. The separate media read port checks Reel exposure ownership/current epoch
and admitted revision on every grant and byte-range request.

## Navigation and actual activation (0018, #234 backend slice)

The API composition now binds discover/return open, all shared semantic navigation modes, offer
activation, current context, Like/Unlike/Hide, and exact Saved hydration. Direct open/activate and
unlinked Save/Unsave retain their existing operations and receipt versions. Back restores the parked
reader without a command. This backend source does not constitute a connected client journey.

Navigation locks the personal root for Tx1 (receipt/epoch/latest intent/source membership + bounded
content/Personal Context snapshot), runs pure Composer **outside** the transaction, then locks for Tx2.
Tx2 rechecks receipt/epoch/latest intent, any activated same-session source, each selected exact
revision/current admission/render support/Hide and exact continuity version. It atomically commits
receipt/session/decision/at most three immutable offers. Catalog drift permits one rerank; a second
drift refuses `OFFER_UNAVAILABLE`. No model, provider, HTTP wait or new supply request occurs.
An empty inventory is exhausted. Explicit target revision/format wins; no replacement is silently opened.

Offers persist the fixed experimental `offer.v0` policy version and its 15-minute TTL. A fresh activation command requires current
intent, TTL, exact access/support and displayed link validation. Concurrent/repeated valid commands
reuse one bound exposure. A **completed identical activation receipt** replays its original result
after live scope/epoch and current exact access/support checks; later TTL/session progression cannot
undo it. Withdrawal refuses even completed replay. Buffering itself creates no exposure/evidence.
Current context reads the latest session revision, current Saved/Like/Hide and admitted continuity
and format siblings. It exposes no scores, producer provenance or personal raw history.

An optional action exposure must be owned, activated, current epoch and the exact requested revision.
Without it the action is an asset preference only. Unlike/Unsave correct the original credited
encounter, using retained original action/exposure pointers. They never guess the newest exposure.
Owned Saved removal remains possible after correction/withdrawal; hydration preserves the original
revision and explicitly reports corrected/withdrawn availability.

| Personal table | Purpose / indexed query | Growth / retention / erasure |
|---|---|---|
| `sessions` | Own session ID, latest revision and declared capabilities/intent | One per session, bounded JSON; retained until full erasure |
| `offers` | Immutable exact descriptors + owned decision FK, scoped session/intent index and same-session source FK | <=3 per committed decision; 32KiB descriptor; TTL is activation eligibility, not physical deletion |
| `offer_activations` | Unique own offer -> one actual exposure | <=1 per activated offer; erase before offers/exposures |
| `encounter_lineage` | Actual activated immutable revision/explanation/facets; scoped recent and explanation-time indexes plus facet GIN | One per actual exposure; recent read <=20 within24h, established probes <=100 units/16facets; retained history, no learning claim |
| `encounter_activity_inputs` | Current independent action/navigation flags and revisions, exact exposure key | One per actual exposure; baseline false never invents a measurement |
| `action_state`, `action_links` | Current asset preferences/original credit pointers and immutable action audit | One state/asset + one link/action; only explicit commands; full erasure deletes before actions/exposures |
| `navigation_transitions` | Actual activated destination/source and typed mode, source index | One per activated offer; H only deliberate series/related source, R only separated explicit return |

Migration18 backfills only real retained activated metadata. Existing unknown measurements remain
unknown. Full AccountScope erasure deletes evidence first, offer references before decisions, then
exposure roots; shared content survives. The existing generic clear-all is **not** selective history
clearing. Offers and sessions have no maintenance scheduler in this slice. Retained offers can delay
physical Composer decision pruning after its 30-day logical read expiry.

Navigation's new receipt operation names satisfy the unchanged `<module>.<operation>` grammar
(`experience.compose-open-v0`, `experience.navigate-v0`, `experience.activate-offer-v0` and
`experience.encounter-action-v0`; outcomeVersion1). Legacy operation identities stay unchanged.
A navigation receipt stores `navigation-receipt.v0`: immutable common outcome fields/status and
ordered chosen/buffer offer IDs (<=3), well within the unchanged whole-receipt8KiB limit. Replay
reads only those exact owned epoch/session/intent/decision-bound immutable offer descriptors, never
current catalog metadata or context. It does not reapply offer TTL. The public wire remains full
metadata. The independently bounded offer descriptor permits32KiB to accommodate all valid shared
metadata and conservative JSON escaping, without truncation or dropping Composer selections.
Descriptor/binding/policy rewrites are refused by a database trigger; full AccountScope erasure
removes the private receipt and offer references together. A missing/inconsistent replay reference
is an internal availability refusal, never a silently rebuilt current result.


## Personal Context preparation (#235)

Navigation's existing prepared-input capability now requires READ_COMPOSER_CONTEXT from the PC owner.
The API and worker install that adapter through personalContextProviders. It reads the revisioned
exploration snapshot within Tx1's existing personal lock, maps available A/Q/O and actual bounded
routing history, and preserves neutral absent-topic history. The exact versioned PC/scope watermark
is copied into the private Composer decision's context binding. The read changes no scope or PC
revision. Tx2's authority/epoch/intent/admission/Hide/continuity rechecks remain unchanged. A missing
PC provider fails DI; no Evidence preparation fallback exists in shipped navigation. No raw context,
scores, structural support or provisional observations are added to the public navigation wire.

`CHECK_REQUEST_SOURCE` (#239) is an owned, activated, exact-revision/epoch lineage read inside an
already locked personal scope. An optional Composer session must contain that activated exposure
and name the session's latest intent revision. Omission preserves direct-encounter use. It grants
no Content eligibility or consumption evidence; Supply separately rechecks current Content after
its SHARE wait. The deliberate submission's session fence does not make later ordinary navigation
revoke an accepted request. Existing experience/navigation/open reads retain their semantics.

## Durable Keep place prerequisite (#246, migration0029)

Experience owns a private immutable Saved membership UUID and latest
`experience.saved_places`. Existing real Saved rows receive identities only;
no position/encounter is invented. New Save uses UUIDv7; a compatibility SQL
default supports older inserts. Same Save retains the actual stored ref/time/ID;
conflicting inserts do nothing. A database trigger refuses membership rewrites.
Unsave cascades its place; resave creates a different identity. Legacy Save-noop
receipts still echo the requested revision and must not construct a Keep entry.
Legacy asset-keyed Unsave still has an ABA gap; it is not membership-fenced here.

`keepPlaceUseCases`/`keepPlaceProviders` are explicit factories, now mounted by
the API Keep controller. They implement the accepted strict `keep-place.v1`
Read/Set schemas. Order is READ COMMITTED own root → actual Identity
`FENCE_OWN_ACCOUNT` UPDATE gate/fresh authority → exact Saved membership → Content
SHARE/canonical target. Plain AccountAccess does not prove lock ownership.
Unavailable reads omit position and metadata; wrong requested stored revision is
not_saved. Current membership/eligibility precede every receipt/CAS access, so
withdrawal, correction, Unsave/resave, suspension and old scope cannot replay
private results. UUID comparisons use relational identity; read target echoes
preserve the initiating UUID spelling. There is no redirect to another revision.

Set hashes the full original validated command under internal receipt operation
`experience.keep-place-set`, outcomeVersion1, before contextual clamping. An
identical authorised replay returns immutable acceptance before testing its old
expected revision. Stored acceptance is strictly parsed and bound to command,
entry, scope, epoch and original expected revision; impossible current place
regression/corruption fails closed. Changed body/operation or retired/old-epoch
receipt refuses key reuse; a newer outcome version is unavailable. No legacy
receipt is reinterpreted. Acceptance contains no position/current snapshot.

Each new Set increments place revision exactly once even for equal positions;
two devices have one CAS winner. Only authorised staleness returns current
revision. Place counters are safe bigint values; existing root integer capacity
is checked before new effects. Reel clamps to the canonical immutable duration
and preserves fractions; Scroll validates the actual top-level anchor and stores
finite logical pixels without inventing server geometry. Later renderer layout
clamps actual measured blocks. No copied universal60second policy exists.
Pending receipt, CAS place, position-free acceptance, one root increment and
transactional disposable hint commit atomically. No action, exposure, Evidence,
job, external I/O or provider work is created. No automatic stale overwrite.

The SQL constraints close both position branches with guarded numeric casts and
safe bounds. Migration29 backfills/validates/indexes under the migrator's one
transaction, with bounded lock/statement timeouts and documented narrow SQL-lint
exceptions: actual rollout requires reviewed stopped-service/backup handling,
not an online-maintenance promise. Existing0001..0028 and pool SQL are immutable.
Codegen uses a fresh owned full ordered schema, never manual generated-type edits.

All-data erasure explicitly deletes places before Saved across every retained
scope version; existing receipts/jobs erasers remove old epochs too. Current
eraseUniverse still deletes Keep. Exploration-clear preserving Keep, inactive
account deletion, backups and local position purge require later explicit
lifecycle/client work; Identity309 and registry inventory do not execute it.
There is no Keep worker/job. Old-scope generic work is refused at the scope gate.

Canonical Content318 stored admission remains unchanged, including bounded CPU
proof work while the transaction is held. Worst-case valid-document transaction
and installed HTTP latency are measured by authored Actions probes before a client consumer.
The20 serial warm samples per operation/control follow three warmups, retain cold samples
separately and report actual CPU/transaction/query/commit-return spans plus HTTP wall time.
They include the existing full eight100×100-grid canonical proof, not a cheap parser or
prevalidated flag. Query spans include real lock waits; commit-return includes driver overhead.
They establish neither production percentiles nor an accepted client response/lock budget. Actions fixtures cover real-PG CAS/receipt/identity/
Content/membership races, rollback after receipt/place/hint, strict JSON, actual
resume units, counter limits and all-epoch erasure. The thin API source mounts read/set without a worker or new business authority. No client
journey, privacy completion, runtime rollout or full #246 acceptance is claimed.

## Exact Saved membership removal (#246)

`KEEP_REMOVAL_USE_CASE` / `keepRemovalUseCase` is a separate `keep-remove.v1`
command mounted by the API. It strictly hashes the original command under
`experience.keep-entry-remove`, outcomeVersion1. One real personal root and the
actual Identity own-account UPDATE/fresh-authority fence precede receipt access.
A valid immutable historical acknowledgement replays BEFORE looking for the
membership the command already removed. A replay of A leaves a later Save's B
and place untouched; a new command naming missing/replaced A returns the same
fixed `KEEP_ENTRY_UNAVAILABLE`, with no B identity or current-absence claim.
Changed keys/bodies/old epochs/retired outcomes refuse; newer or corrupt stored
acceptances never become a fresh action.

A fresh command must match the actual Saved UUID and immutable asset/revision.
No Content admission, canonical document or playback grant is needed to remove
a withdrawn/corrected saved ref. Existing `readChannels` and `makeCommitAction`
perform the Unsave under that SAME scope: action/link/state and credited-origin
correction, Saved/place cascade, required pg-boss work, pending/completed receipt,
one root increment and disposable notice commit atomically. Root integer capacity
is checked before new writes. No nested public action call, isolated Saved delete,
new consumption/exposure/observation or independent outbox is introduced. Old
Read/Set and legacy Save/Unsave implementations remain unchanged.

Actions-only real PG/pg-boss and installed HTTP fixtures cover replay after deletion,
ABA/resave, corrected/withdrawn refs, current owner/account/epoch waits, duplicate
commands, removal/Set ordering, receipt corruption/version refusal, post-write
rollback and actual saved-channel correction retaining Like. No local suite,
provider or owner-data operation is implied. The closed14-code removal HTTP family
contains only seven schema-owned issue tokens; no position/CAS/replacement metadata.
This source endpoint does not migrate the app's legacy Unsave, supply Undo, complete
selective privacy or establish real two-device/runtime acceptance.

## Complete live Saved paging (#344)

`ReadSavedPage` consumes accepted `saved-page.v1` on the existing GET `/v1/saved`.
The new use case locks/rechecks the current personal root and own account (and
honors the Clear barrier) before consulting its opaque cursor port. Each response
is current membership and allowlisted Content availability, not a retained
snapshot. Personal revision is catch-up only; no total, place, evidence, root
increment, receipt, exposure or job is created. Legacy `listSaved` is unchanged.

The existing `(universe_id,saved_at DESC,asset_id ASC)` index supports keyset reads.
Keys retain exact UTC microseconds as strings end to end; the SQL ordering uses
the timestamp column, never its formatted alias, JavaScript Date or OFFSET.
Continuation seeks the same timestamp's later UUID range, then older timestamps,
with bounded LIMITs. At most101 keys are read, only100 identities and Content
metadata refs hydrated. The extra key is lookahead only. Filtering uses actual
Content kind including withdrawn rows through its public read port, with at most
100 candidates per request. An empty filtered window may have more; it does not
assert an empty library. When the output limit is reached, the next cursor names
only the last consumed candidate, preserving unreturned matches. Deleting that
anchor does not invalidate its key; a resave's new UUID/time follows live order
and is seen on Refresh if newer than the anchor. No migration/index is added.

The API composes per-instance authenticated confidential five-minute cursors.
Scope/filter/limit/purpose/epoch mismatches and expiry/rotation require a fresh
traversal, never authority bypass. API-instance keys are separate from personal
scopes and media grants. Domain code performs no crypto/network/config work.
Actions-only real PostgreSQL fixtures cover160-row traversal,110 tied rows,
submillisecond boundaries, late kind matches, withdrawal, deleted/resaved anchors,
100-ref budgets, unchanged activity/root state and current authority after real
root/account lock waits. Complete deployed/UI acceptance remains under #344.

### Region preview, deliberate Open and constrained activation (U04)

`REGION_ENCOUNTERS` preview uses current personal/root/account authority and reads one honest canonical card without creating a session, offer, exposure, receipt, decision, root stamp, job or hint. Unmapped/unsupported Regions return explicit unavailable responses. Deliberate Open delegates to the existing two-transaction Composer/navigation engine; supplied displayed A is mandatory as the exact eligible asset, never silently replaced with B. The optional existing session retains exact session/intent concurrency semantics. Unknown acknowledgements recover through the original command receipt/body.

Every chosen and buffered regional discovery offer carries an immutable private `experience.offer_region_constraints` child. Its Geography snapshot and coverage identity are rechecked on current authority before receipt replay and activation. Vertical continuation inherits the same Region; series, related, variant and return retain their distinct relationships. The 100+1 bounded lookup reports uncertainty rather than manufacturing exhaustion. No new model call or provider/network work runs on this path.

The concrete personal erasure inventory includes `offer_region_constraints`, removed before offers across all epochs by both full erasure and selective Clear. Saved items, Saved places and shared Content projection survive selective Clear. Historical Geography IDs deliberately have no live Geography FK because Geography erases earlier in the registry; activation always rechecks live Geography instead. Content mapping FKs retain the exact immutable accounting of selection, never permission to activate an old mapping.

Schema0037 adds structural compatibility guards. Old writers cannot bind a regional offer without the new transaction-local protocol marker or commit a generic vertical child that sheds its parent Region. The new adapter sets the marker only after consuming an unforgeable one-use live-scope/offer permit minted after current authority checks; the marker alone is not business authority and disappears on commit/rollback. Ordinary legacy offers keep their behavior. A rolling downgrade is unsupported: incompatible processes must be stopped, and the existing exact schema release guard must refuse old code against schema37. These guards do not retroactively give an old process the new read/receipt replay checks.


## Recording provenance prerequisite (#381, source only)

The command/offer/session hooks implement the reviewed recording design without exposing a
Pause controller or toggle. The immutable original optional `recordingGeneration` participates
in command hashing only when supplied; omitted bodies retain their original hashes. Supplied
undefined/malformed fields refuse rather than downgrade. An own-account UPDATE/fresh authority
fence follows the real personal-root wait and precedes every command receipt lookup. Replay
returns the original acknowledgement without a new action, origin, session, queue or correction.

Necessary Saved/Like/Hide/navigation/Keep state and receipts still commit while recording is off,
stale or missing after the first toggle. Their immutable `recording_command_origins` store the
original supplied generation and independently eligible generation, never resumed server-current.
Composer Tx1 eligibility survives the outside-transaction compose and bounded rerank; Tx2 can only
narrow it. Each of at most three offers retains that intent origin. H/R requires that intent and
actual activation to be eligible in the same generation. Old source exposures gain no H without an
actual same-generation activation. Routing/opening/grants alone never qualify consumption.

The original provider composition is a **legacy initial1/on compatibility composition**. Its real
recording fence refuses collection after any toggle, even if a fresh command supplies generation3.
It does not provide v2 recording readiness. The explicit recording-aware composition requires
`options.recordingEffects` naming a complete `ExperienceRecordingEffects` provider. Missing or
incomplete methods refuse factory construction; there is no empty success implementation. Evidence
owns its session/queue/reducer adapter and the required PC effect. API/worker composition and all
recorder/client/role consumers must be separately completed before controls are exposed.

A fresh eligible activation command may create a session even when the immutable exposure is
already active. Its command ID is the recorder session ID. `serverStartedAt` is captured within
that accepted root/account transaction; only the client monotonic clock starts after the correlated
ACK. Exact replay creates no session. The generation segment stores immutable attribution and a
separate first actual eligible activation pair; an action/correction initialization is not an
encounter or R predecessor. A bounded reverse exact-exposure index seek checks the pinned descriptor;
changed attribution creates no new session. A restart preserves the first activation and earns no
H/R. Session creation alone enqueues no zero-valued activity or semantic growth.

L/B uses an independent latest eligible asset/channel pointer in `action_state`, separate from
necessary flags/origins. A positive domain no-op cannot backfill a paused Save/Like. A fresh eligible
negative may retract a prior generation's effective credit, including when necessary state is
already false. A real new positive edge atomically moves the pointer and corrects at most old/new
two exposures. Current-generation inherit/true/false overrides bind the exact original action and
source generation; old audit heads remain immutable. The legacy use case passes its authoritative
pre-write `changed` result rather than inferring an edge from the post-write Saved row.

The synchronous owning effect returns `{changed:false}` or `{changed:true,revision}`. On an actual
derived delta Evidence allocates one revision/material-change effect for the complete group and
emits no notice; Experience reuses it for the command acknowledgement and emits its single notice.
Necessary-only changes advance once as before. Failure of either exposure/required effect rolls
pointer, origin, action, receipt, domain state, aggregates and jobs back together. The derived port
uses the genuine `RecordingScopeTx`; it does not retag the old source as current input. PC must use
its own committed baseline and separately current segment qualification, never Evidence's inherited
aggregate-qualified flag.

**Legacy certification remains unimplemented and unallocated.** New nullable pointer state means
uncertified, never false. Neither current Saved/Like flags nor the newest action proves uniqueness:
a retained committed E1 positive may coexist with a pending old retraction and a later E2 pointer.
Recording-aware positive credit therefore stays unavailable for uncertified channels. The safe next
seam is an explicitly allocated initial1/on durable finite-page certification over real committed
sources and pending-work convergence, with an authenticated epoch/generation-bound ceiling/cursor,
fixed page budgets and typed unknown/overflow. A toggle invalidates incomplete work; it cannot
repair old inputs after resume. No certification operation, historical scan/backfill or implicit
initialization is included here. Existing selective Clear erases all four new Experience stores
and the entire pointer row while preserving Saved; surviving Saved state cannot recreate credit.
Epoch-only invalidation also resets recording fields to uncertified rather than inheriting them.

Actions-only fixtures retain all prior assertions and add original-hash separation, off/stale
necessary effects, replay after toggles, real root/account waits and required-port rollback.
The new recording-aware positive Evidence/PC composition, finite legacy certification, deployed
journeys and complete Pause acceptance remain separate prerequisites. Remaining concrete consumers
include `apps/api/src/modules/experience.ts`, `apps/api/src/modules/evidence.ts`, worker job/owning
Evidence provider selection and the recording-aware client/recorder wiring; none is activated by
this source slice.

## Fresh lifecycle channel certification (0044; source only)

The separately allocated fresh-lifecycle protocol now enables genuinely new roots and verified
current Clear cores, while retained legacy channel certification remains unavailable. A real
eligible action can initialize one exact asset/channel certificate under the genuine original-g
capability and actual Identity lifecycle read. certified_empty has no first decision and no
pointer state; it is never a fabricated false action. The first real decision sets the pointer
and immutable first-decision link. Independent Saved/Like channels do not initialize each other.
Positive domain no-ops may persist only certified_empty metadata bound to that real eligible action; they create no pointer decision or credit. They do not backfill paused Save/Like, including Saved surviving Clear. Real
negative commands can correct tracked credit, including a necessary-state no-op after paused
removal. Legacy unknown is preserved, with no scan, newest-action guess or migration backfill.

The producer captures old origin, prepares at most old/new two segment overrides, CASes the
pointer and certificate BEFORE invoking the required grouped Evidence effect in the same TX.
One derived revision/material change and the producer's one notice retain the existing protocol;
all failure paths roll action, receipt, certificate, pointer, segments, aggregates and jobs back.
READ_RECORDING_CHANNEL_SELECTION is a bounded pure exact-key owning read, supplied via real DI.
Evidence validates positive effective L/B against the current selected exposure/action.

Action/navigation/activation/Keep factories require the actual lifecycle read. A fresh eligible
command in a legacy factory missing required recording effects refuses rather than stamping
legacy growth. Off/stale necessary commands retain their behavior. Keep removal forwards the
original optional generation without stamping or changing its position-free acknowledgement.
Required API/worker/helper wiring and coordinated process replacement remain rollout work; no
consumer control or installed recording journey is accepted by this source slice.


### Retained recording routing facts

Routing history reads both legacy actual encounters and recording segments with a non-null first
eligible activation. Each scoped time-index lane reads at most20 raw rows in the last24hours;
the at-most40 rows merge by exact activation timestamp/exposure, deduplicate exposures, and return
at most20. Duplicate generations can exhaust a lane: there is no refill or completeness claim.
Recording attribution wins an exact legacy tie. No current-generation filter relabels retained
facts; paused reads retain old eligible history while paused activations and correction-only
segments add no encounter. The unreleased0042 includes scoped recent/unit indexes and a partial
facet-expression GIN. Established unit probes are exact; facet probes preserve ANY encountered
unit semantics, independently of the candidate unit. At most100 candidates/16facets and100 asset
IDs enter these probes. These are routing/novelty facts only: they neither qualify an exposure nor
create Personal Context support, learning, credit, a session, or collection authority.
