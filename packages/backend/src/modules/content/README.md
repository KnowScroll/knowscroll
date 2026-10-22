# modules/content

## Trusted Scroll coverage foundation (#237)

`content-concepts.v1` declares a small source-reviewed canonical topic/facet vocabulary with explicit
parents and meanings. It admits no content, personal support or planet. Prefixes, titles, discovery
facet tags and personal/model labels never establish membership. The frozen catalogue and each
topic/facet meaning have deterministic SHA-256 identities.

`0022_content_coverage` adds shared `coverage_revisions` (one immutable, <=32KiB mapping per
correction/retraction) and `coverage_heads` (one monotonic head per exact asset revision). Both use
the immutable asset-revision FK and exact indexed keys; neither contains a person, observation or
consumption result. History is retained; personal erasure leaves this independently reviewed shared
content metadata. No migration seed/backfill or live semantic approval is included.

The composition-only `coverageAdmissionUseCase(db)` is a trusted write capability bound to
**source-reviewed full command digests and semantic review references**. The shipped approval list
is empty: a consumer-supplied string, matching title or explanation ID cannot authorize admission.
The lower-level admission-port/factory seam is for trusted composition and explicitly labelled CI
fixtures only; never supply its approval callback from a request, environment or model output.
There is no HTTP/admin/operator command or provider dispatch for coverage in this foundation.

An approved command binds exact asset/revision, document/provenance SHA, explanation unit, factual framing
digest, derived reading-facts v2 digest, catalogue and meaning digests. It can map <=16 topic/facet
bindings, each an ALL-OF set of 1–8 existing top-level paragraph/quote/callout IDs. Nested children,
disclosure parents, headings, interactive states, Reel, hypothetical/perspective framing and fixture
production provenance are refused. Admitted immutable Scroll/document/provenance identities are
rechecked from storage; reading facts are derived through the existing Content compiler.
Mapped claim bindings must have documented/synthesis truth states; interpretation, disputed,
modelled, counterfactual, fictional or missing claims are unsupported in this initial policy.
An unbound authored leaf still requires the explicit exact-map semantic review; it gains no
automatic factual authority from this absence of claim bindings. Structural
checks cannot attest semantic correctness: a source-reviewed exact mapping remains mandatory.
Documents, provenance, discovery tags and access/withdrawal rules are not modified.

Admission takes its own short Content transaction: per-asset/revision advisory lock -> asset SHARE
-> head UPDATE. Expected head revision fences concurrent corrections; identical current command
replays without appending, A→B→A uses new revisions, and retraction appends a new retained head.
Database triggers reject revision update/delete and nonmonotonic/removed heads. Failure rolls the
whole transaction back. Admission never takes a personal root or performs network/model waits.

`READ_ADMITTED_COVERAGE_MAPPING` reads one exact revision in an existing personal transaction and
returns mapped/unmapped/retracted/unavailable. An older revision is still exact historical content;
a withdrawn asset is unavailable. This read confers no opening permission and proves no reading.
`LOCK_CURRENT_COVERAGE_AUTHORITIES` accepts 1–100 unique exact expected heads (<=128KiB), normalizes
UUIDs and orders locks by canonical asset UUID/revision. Lock order is caller personal root -> all
asset SHARE locks -> head SHARE locks. It revalidates active heads, hashes and current admission;
false means the consumer must reject its proposal. SHARE locks remain until the caller transaction
ends, blocking head correction and asset withdrawal. No personal revision/effect is written.

Evidence/PC/Cartographer consumers are deliberately separate work. In particular, no qualified
facet is emitted, no q/activity policy changes, no Reel time mapping, provider budget or formation
is enabled here. Existing `coveredFacets: []` / unavailable coverage remain truthful. Future
consumers must verify actual observed static block coverage, preserve truth context/epochs,
reference-count variants and recheck these current authorities before applying a proposal.

Verification is labelled CI fixture: source/unit/property and real PostgreSQL append-only,
concurrency/SHARE-lock, correction/retraction, stale/forged/wrong-revision and rollback cases.
Automated suites run in GitHub Actions only; codegen on an owned empty schema is not runtime
admission or generation evidence.

Shared, immutable content: assets, their admitted revisions, and the internal provenance each
revision rests on. **Content is not personal data**: no table here has a `universe_id` or an account
column, none is in the erasure registry (clearing a universe, a privacy reset or deleting an account
leaves it), and nothing here records who read what.

## Tables

| Table | Migration | Holds | Erasure |
|---|---|---|---|
| `content.assets` | `0003_content_assets` | Asset identity, `kind` (`reel`/`scroll`), `status` (`admitted`/`withdrawn`) and the **current** revision | None: shared content |
| `content.asset_revisions` | `0010_content_asset_revisions` | One immutable row per admitted revision: `provenance_kind` (`authored_editorial` · `generated` · `cutroom_import`, D-005), the consumer document (`document_version`, `document`, `document_sha256`), `explanation_unit_id`, `language`, `title`, and the derived `reading_facts` | None: shared content |
| `content.asset_provenance` | `0010_content_asset_revisions` | The internal provenance of a revision (claims, sources, bindings, checks, production record). Written by admission, **read by no API route**: the consumer document and its provenance are separate tables, so no read of the document can return them | None: shared content |
| `content.scroll_production_runs` | `0015_scroll_production` | Private nonpersonal topic/version jobs, frozen research/passages, accepted claims, code-only outcomes, draft and publication pointer; no consumer read port | None: shared public supply |

A revision’s document, provenance and identity are never updated; a content change is a new revision, and anything that rests on one (an exposure,
a saved item) keeps pointing at exactly the bytes it presented.

The storage adapter validates derived reading facts against the canonical Scroll block registry. Domain facts stay plain data; evidence checks declared interactions through content’s framework-free public predicate, without importing renderer schemas into domain/application code.

## Use cases and ports

| Operation | Caller | Authority, effects, failure |
|---|---|---|
| `importEditorialScroll(source)` | Operator command `dist/operator.js content import-editorial --file <path>` | Allow-listed worlds only (`dev`, `stage`, `ci`, `local`; the command refuses elsewhere before touching the database). One transaction serialised per asset (advisory lock): compile the source at the current revision and compare the integrity hash (equal → refresh derived reading facts if needed (`facts_refreshed`), otherwise `unchanged`); otherwise compile at the next revision number and store the revision, its provenance and the asset's new current revision together (`created` / `revised`). Compilation is scroll-model's **admission** path (staged draft checks, honesty rules, copy check, code-set measures, integrity hash) followed by `admitDocument` on exactly the stored bytes. Refusals (`source_invalid`, `compile_refused` with `stage` and issue codes and paths, `asset_is_not_a_scroll`, `asset_withdrawn`) write nothing and never echo source text. |
| `FindOpenableAsset` (token `FIND_OPENABLE_ASSET`) | experience | The asset's kind, current revision, status and the document hash, inside the caller's personal transaction, no lock |
| `ReadScrollReadingFacts` (token `READ_SCROLL_READING_FACTS`) | experience, evidence | The block weights and types, the owner of each nested block and the reading estimate of one stored Scroll revision, derived at admission from the document's code-set measures and validated on read. Old facts versions are derived from the immutable admitted document on read until re-import persists the current view; unsupported stored documents raise `READING_FACTS_REQUIRES_REFRESH` rather than masquerading as a lineage mismatch |
| `RenderScroll` (token `RENDER_SCROLL`) | experience | Reads the stored consumer document (never provenance), parses it on the client path, and **negotiates** it for the capabilities the client declared (D-012): unsupported blocks become readable fallbacks, essential ones are reported. Parsed documents are cached (immutable, 32 entries) |
| `FindAssetForAction` (token `FIND_ASSET_FOR_ACTION`) | experience actions | Does the asset exist, is it admitted, at which revision |

`adapters/cutroom/wire-v1/` is the byte-for-byte vendored Cutroom wire schema (CF-61): not built,
linted or formatted; verified by the `integrity` CI job.

## The starter Scroll (D-005)

`starter/why-the-sky-is-blue.editorial-scroll.json` is one original, authored explainer in
`scroll-document.v1` producer form (an `editorial-scroll.v1` source: publication facts, the authored
`scroll-draft.v1`, no claims because it states no digits). It is labelled `authored_editorial` (the
production record is set by code from the file's `reference`, so an authored piece can never claim to
be model-written) and is never presented as generated. Seven sections, text-family blocks only
(subheading, paragraph, list, quote, callout, disclosure), about four minutes. The build emits the JSON
next to the compiled code: in a release tree it is at
`node_modules/@knowscroll/backend/dist/modules/content/starter/why-the-sky-is-blue.editorial-scroll.json`.
`content/` at the repository root is frozen v1 data and is never read.

Jobs: none. Lock order: an advisory lock on the asset ID, then the asset row; admission holds no personal
root and never takes one. Erasure: none (shared content; stated above).

`reading_facts.v2` is a refreshable derived view, separate from immutable document/provenance bytes. Re-importing an unchanged source repairs it under the asset admission lock without creating a revision.

## Approved Cutroom reuse and Reel media (S2.4, #233)

The worker operator `content import-cutroom-reel --run <uuid> --script <name>` imports only the
three D-005 approved runs (greenhouse, seasons-v5, tides-v4). Their original script/approval snapshots
and coordinator-read media digest/size pins are kept under `approved/`; frozen root `content/` is never
read or edited. `legacy-cutroom-<script>` is the shared explanation identity of Reel and future Scroll
siblings. GET-only loopback reads use the actual pinned upstream parsers, compiled to JS at build;
no commissioning, resume, cancel, model, quota, money or provider adapter exists here.

Import validates terminal/run/request identities, every chosen/used engine check and shot/degradation
coverage. Cutroom places up to three pictures; other shots can be text-to-video and need no chosen
picture. Wire v1's `used` flag attests inclusion in the completed render; it exposes neither take mode
nor a take-to-picture relation. Result stills must still join chosen pictures by picture and shot ID,
and each chosen picture's shot must have a used take or degradation. Import then opens a contained
regular engine artifact, stream-stages, hashes, ffprobes H264/AAC
portrait 24fps 48kHz stereo/20–60s/faststart, installs bytes, and commits an immutable revision with
internal provenance in one short admission transaction. No network, media copy or probe is inside that
transaction. Nonfixture imports must match the frozen approved SHA-256 and size; a repeated run is
unchanged. Engine witness evidence is labelled **engine-attested, not independent**. Absolute paths
are neither documents nor diagnostics; captions are burned into the real approved MP4s.

Migration `0014_media_reels` adds shared `media_objects` (logical key/backend/checksum/size/MIME/revision/
probe) and `reel_imports` (run → immutable revision/media). Shared data is retained across personal reset.
`--fixture` is accepted only in `ci`/`local`, and a DB trigger additionally confines fixture rows to
`ks_it_*`/`knowscroll_fixture_*` disposable databases. Fixture titles/documents are explicitly labelled.

The API reads media only through a caller-owned exposure at its live privacy epoch and an admitted
asset. The consumer `reel-document.v1` contains logical media keys, title/summary/duration/dimensions and
truth/fixture/caption labels; internal production/checks/approvals never appear in it. Media grants are
separate ephemeral access credentials, never content provenance or consumption evidence.

## Generated Scroll production

The worker's `content produce-scroll --topic seasons|tides|greenhouse [--dry-run] [--resume]`
uses content-owned claims/writer roles through the explicit nonpersonal harness (0013), never a
personal universe. Both roles put code checks inside the harness's single repair boundary: at most
four model requests per topic, with uncertain attempts never resent. Publication closes the writer
run and stores the immutable admitted revision in the same production-root transaction. Research
and model waits happen outside it. The same version reruns idempotently; explicit resume continues
frozen stages after a crash. See [production/README.md](production/README.md) and the
[operator runbook](../../../../../docs/v2/operations/scroll-production.md). Fixture CI and real
provider/browser evidence are separate requirements; no authored starter is labelled generated.
## Admitted discovery and continuity (#234 first backend slice)

Implemented backend capabilities, without navigation/API consumers: `ReadDiscoveryCandidates`,
`ReadExactEncounter`, `ReadContinuations`, `ResolveContinuityLink`, `ReadEncounterTopics` and
`ReadSavedMetadata`. They run in the caller's already authorized personal transaction and read
shared admission only; they create no personal activity. Existing Scroll/media ports are preserved.
The present access model is shared admitted assets; no private-content access policy is invented.

| Table (`0016`) | Purpose, query, indexes | Growth, retention, erasure |
|---|---|---|
| `content.discovery_revisions` | Admission-derived summary/facets, attribution version and indexed text; keyed exact asset/revision. GIN text/facet indexes plus language/current-status/kind and explanation indexes on existing tables support bounded retrieval. | One bounded metadata row/revision; summary<=2000 characters, <=16 facets. Shared retained projection, no personal erasure. |
| `content.encounter_topics` | Real primary/supporting/incidental attribution. Revision FK and topic/revision index; <=16 unique topics, positive weights sum<=1 enforced by SQL and domain validation. | At most16 rows/revision. Shared retained facts; no personal erasure. |
| `content.series_units` | Explicit versioned series/part -> immutable revision, primary series+revision+part and unique member constraint; asset/revision index supports exact metadata. No inferred total. | <=99 units/series revision; bounded admission batch<=100 units. Retained shared authority; no personal erasure. |
| `content.continuity_links` | Versioned explicit previous/next series step or related move, exact source/target revisions, strength and private authority reference. Unique active source+direction index; UUID lookup. | <=3 active links/source revision. Replacements require a new ID and increasing link revision; older immutable facts remain inactive. Retained shared authority; no personal erasure. |

Revision insertion projects consumer-derived summary/text without altering document/provenance
bytes. Existing real revisions are backfilled. Topic authority `admitted-brief-taxonomy.v0` maps
only the actual approved seasons-v5/tides-v4/greenhouse concepts to `earth.seasons`, `earth.tides`,
`earth.greenhouse-effect`, one primary weight 1. It requires completed `reel_imports` facts matching
the frozen approved **run ID, script, media digest and size**, exact revision and import provenance.
The import-completion trigger runs after its import row exists in the same admission transaction;
a failed import leaves no projection. Synthetic imports and arbitrary editorial explanation-ID
lookalikes stay unknown. New generated Scroll attribution uses the private producer completion hook (`0015` + `0016`):
it requires actual same-scope writer closure/accounting and the exact published job, admitted
revision and matching model provenance. Fixture/foreign/incomplete authority stays unknown.
Historical reconciliation remains deferred until a separate completed-run attestation port exists. No title-derived
concepts, Part 2/related edges, invented semantic variety or personal-activity-derived topics exist.

Discovery retrieves an indexed union of topic matches (max 40), text matches (max 30) and general
eligible inventory (max 100), deduplicates to<=100 current admitted candidates before scoring and
applies declared languages/formats plus exact Scroll capability negotiation/Reel document support.
It has no history traversal, embeddings or provider wait. Unknown-attribution inventory remains
eligible for unconstrained discovery. The exact read negotiates the specified stored revision and
checks current admission; it never substitutes the asset's current revision. Snapshot watermarks
hash immutable bytes plus bounded attribution/sibling/series facts. Current eligibility must be
rechecked by future activation; a read does not reserve publication or grant activation authority.

Existing format siblings use real explanation identity and current admitted revision, distinct
from explicit series/related links. Sibling references and continuity facts alone are not
rendering/activation authority: the consumer must exact-read the target with capabilities. A
continuity read returns at most 3 active exact links and omits withdrawn endpoints. Expected link,
source, target and optional link revision must all still match on resolution.

`admitContinuity` is an operator/admission capability requiring the existing `AdmissionTx`; no
consumer input invokes it. A single shared metadata advisory lock serializes bounded batches,
with no personal root acquisition or external wait. It validates real supplied authority refs,
exact admitted revisions, unique units/slots and declared adjacent parts within the same series
revision. A series revision is a complete immutable unit manifest: replay cannot extend/reduce it,
and one immutable asset revision cannot acquire conflicting series identities. Historical
versions remain retained; only explicit active links authorize continuation, never ordinal inference. Related edges cannot masquerade as series, format twins cannot masquerade as another
explanation, and contradictory immutable link replay refuses. There are no runtime relationship
fixtures. Missing authorized facts remain unknown/unavailable.

Saved metadata joins<=100 exact references in one batch, preserves original revisions and reports
available/corrected/withdrawn. Only corrected includes a different current revision; withdrawn or
missing content exposes no title or replacement. This is hydration, not a Saved mutation/API.

Migration rollout is additive; existing processes ignore the projection. The three existing-table
indexes use the transactional migrator with 5-second lock/60-second statement timeouts against the
small admitted inventory; larger rollout requires a separately reviewed concurrent-index plan.
No previously registered SQL/hash changes. `0015` must be reconciled before deploying 16+ to dev.
CI fixtures exercise metadata/authority facts, not actual approved media bytes or runtime journeys.

`ReadEncounterAttribution(scope, exactRef)` is a backend-only historical metadata capability for
an already validated owned activated encounter. It returns exact immutable explanation identity,
real topic/facet attribution and metadata watermark/version, including retained withdrawn revisions.
It returns no document, provenance or render authority. Missing metadata remains unknown. New
offers and activations must separately use current `ReadExactEncounter` capability/admission checks;
this historical read never authorises opening withdrawn content.

## Current-head request binding (#239)

`LOCK_CURRENT_ENCOUNTERS` is a separate public authority port; existing historical
`ReadExactEncounter` and discovery/open semantics remain unchanged. Inside a caller's already
locked personal scope it locks at most 101 exact references' asset rows SHARE in UUID order,
then checks current head, admission and capabilities. Missing/withdrawn/corrected/unsupported
references provide no encounter. Locks remain to commit, so Supply cannot bind a stale ready
head while withdrawal passes it. Content admission never acquires a personal root.

Migration `0024` adds Content-owned `availability_revision` and `availability_changed_at` to
`assets`, with a trigger increment only for actual status/current-revision changes. The existing
asset revision cannot distinguish withdrawal then re-admission of identical bytes. The positive
integer counter fails closed on overflow; no-op/counter-only edits preserve both fields. The port
returns these public availability facts so readonly Supply status can monotonically invalidate
and restore its exact one-time binding. It writes no personal state/hint; global changes require
fresh resource reads. No new rights class is inferred beyond the existing shared admitted model.

## Keep position target prerequisite (#246)

`LOCK_KEEP_POSITION_TARGET(scope, owner, ref)` is a minimized Content read inside
an already open own `PersonalScopeTx`. The production caller must first acquire
Identity's actual same-transaction `FENCE_OWN_ACCOUNT` and check exact Saved
membership, in that order. `owner` is its fresh `AccountAccess` result: plain
context **does not certify a held lock**, and must never be copied/cached as an
authorization capability. This port checks the account actor and exact owner
account/universe/epoch binding and uses `transactionOf(scope)` to reject closed
transactions. Identity/account-gate enforcement and membership remain the owning
consumer's responsibilities; no new fence, lifecycle or ownership bypass exists.

After validating the existing strict `KeepAssetRefSchema`, Content takes SHARE
on the one asset and separately re-reads current head/status after any wait.
The lock remains held until transaction end. Missing, withdrawn, corrected,
missing revision, unsupported or malformed documents all return `undefined`.
The exact stored Scroll is parsed by canonical stored admission validation,
including integrity/measures/bounds; its asset/revision and stored digest must
match. Only canonical **top-level** block IDs leave the adapter; disclosure
children never become parent anchors. Canonical document limits bound the list.
Reel uses the same exact immutable document/media-key binding as the existing
media-access port and canonical `ReelDocumentSchema`; only that document's actual
validated `durationMs` leaves, never derived reading estimates. Existing codec
limits are inherited from its validator, with no copied universal60second policy.
No media existence/probe/byte-read claim follows from this database-only port.

Output is only `{kind:'scroll', topLevelBlockIds}` or `{kind:'reel', durationMs}`.
No document, metadata, provenance, media key/URL, source, topics, exposure,
capabilities or private position are returned. No external I/O, jobs, Evidence,
mutation or rendering grant occurs. This implements no Keep storage/HTTP/client
or selective privacy clearing. Existing Content readers/mutators are unchanged.
`keep-position-target.test.ts` uses synthetic real-PostgreSQL fixtures in Actions
for both SHARE/mutation orderings, post-wait refusal, minimized canonical facts,
bindings, unsupported data and rollback; no live Keep journey is claimed.

`ReadSavedPageMetadata` is the bounded private-library consumer port for at most100
already-authorized Saved refs. It shares the existing metadata query and returns
actual asset kind even when withdrawn metadata is absent. It neither infers kind
from a title nor opens/authorizes withdrawn content. A missing/invalid actual
kind is an invariant failure; no placeholder kind is fabricated. Legacy
`ReadSavedMetadata` retains its original shape. Experience calls only this public
port, never Content tables directly. No renderer, document admission, peer state,
encounter, activity or provider work results from these list reads.
