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
