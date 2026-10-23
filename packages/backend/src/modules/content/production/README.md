# Scroll production

Writer roles belong to content (blueprint §§11, 15). `production/` owns the evidence packaging, the
writer's instructions and checks, the job state and the application of a result.
`infrastructure/research` owns the public HTTP boundary, and the shared reasoning engine keeps
transport, admission and the external attempt ledger.

Status: the pipeline below is **implemented** and has been **runtime-verified** with real
`MiniMax-M3.1-Flash` calls against a local database (summaries in the pull requests for #232 and
#239). It runs as worker jobs (next section). Not yet running on dev.

## Jobs, takes and who sends them

Production is the `content.produce-scroll` job (`events.ts`), one per **recipe, recipe version and
take**. The payload is IDs only: the recipe key, the version and the take. The queue is `exclusive`:
a second send for the same recipe, version and take is refused while one is queued or running, and a
finished or failed job never blocks a new send. The consumer (`job.ts`, wired in `apps/worker`) runs
`makeProduceScroll` with resume on every delivery, so a redelivery after a crash continues the same
business run and an attempt of unknown outcome is never resent. It runs only on a worker that holds the
production grant (`KS_REASONING_PRODUCTION_ENABLED=1`); otherwise jobs wait in the queue.

Who sends a job:

- **Quartermaster Create** (`modules/supply`): inside a person's request transaction, with priority 10.
- **The operator**: `content produce-library [--only <keys>] [--interactive-first] [--dry-run]` sends
  the jobs of recipes that need one, at priority 0, and `content production-status` lists every recipe.
  `content produce-scroll --topic <key> [--take n]` runs one job directly through the same use case; it is
  a debugging tool.

A **take** is a new attempt at a recipe at the same recipe version. Take 1 always may start. A rejected
job is final for its take, but take 2 (then 3) may start once every earlier take was rejected. Never after
a published job or an unknown attempt, and never past three takes. Each take is its own business run with
its own writer run and attempts, so nothing an earlier take sent is sent again. Senders pick the take from
the recipe's standing (`domain/library/serving.ts`): `not_started` takes 1, `running` resumes the latest
take, `retryable` (every take rejected, fewer than three) takes the next one, and `published` and `stopped`
send nothing.

When a daily budget or the provider's quota is used up, the run **pauses**: nothing is sent, the job stays
open at its writer stage and the delivery completes. The next send for the recipe (an operator's library
run, or a person's request) resumes it. A rejection is a verdict on the answer; a pause is not.

## The pipeline

```text
operator ─▶ job (research) ─▶ evidence passages ─▶ writer (1 call + 1 repair) ─▶ compile ─▶ publish
```

1. **Job.** `makeProduceScroll` reserves one job per `(topic, SCROLL_PRODUCTION_VERSION, take)` in
   `content.scroll_production_runs`, then fetches the recipe's public pages by code, never by the
   model, and freezes them on the job.
2. **Evidence** (`evidence.ts`). The frozen page text is cut into passages of 40 to 600 characters
   at sentence ends and numbered `e1`, `e2`, … (at least four, at most 64). A handle maps to a
   claim ID that hashes the page, passage and span, so a resumed job sees the same evidence.
3. **Writer** (`writer.ts`). One call of the stable role `content.scroll-writer`. It reads the
   brief and the numbered passages and returns plain JSON in the authored shape
   (`scroll-authoring.v1`, `@knowscroll/scroll-model/producer`): title, dek and a flat list of blocks,
   where a heading block starts a section and every other block carries `cites`, the handles it
   rests on. A recipe names the rich block it wants (`interactiveKind`: diagram, simulation, chart,
   comparison, timeline or sequence); the instructions describe only that block and the prose
   blocks. The harness allows one repair, which receives fixed, path-located findings and, because the
   writer opts in (`repairWithPreviousAnswer`), the refused answer as escaped, delimited data in the
   user message so it can revise instead of rewriting.
4. **Compile** (`compileGeneratedScroll`). Code converts the authored document into the canonical
   draft, derives the claim bindings from the citations and runs every check: structure, the
   simulation grid proof, numbers (a figure must appear in a passage the block cites; a chart plots
   only such figures), copy limits (no nine words in a row from the sources), reading length (two to
   eight minutes), no source or publisher names, the requested block is present, and stored-document
   admission. Findings are reported at the block the writer wrote (`blocks.7`, `title`).
5. **Publish.** In one transaction under the production root: close the writer run, store the
   immutable revision and its private provenance, mark the job published and project the topic.

Numbers and quotations are checked mechanically; they do not prove that a sentence is entailed by
its passage. Human sampling of generated Scrolls is still required.

## Why this shape

Earlier recipes asked for the canonical draft inside a tool call, then for a JSON string inside a
tool call, with a separate claims call before the writer. Every real attempt failed: a model that
writes a long, deeply nested document inside an escaped string loses count of quotes and brackets
(observed: a dropped quote, an unbalanced bracket). Plain text JSON worked, and so does a flatter
shape the model finds easy: strings for rich text, ids it chooses for diagram nodes, derived
accessibility text and fallback text, and citations instead of anchored bindings. One call replaces
two because the writer sees the numbered source passages itself and cites them per block; code
hydrates the exact text of each cited passage, so a claim is still always a substring of fetched
research. Decision D-032.

## State, locks and recovery

| Stored table | Role | Main query | Lifetime |
|---|---|---|---|
| `content.scroll_production_runs` (0015, 0045, 0050, 0052) | Authoritative, private job: research pages, the authored document and the cited claims once published, code-only outcomes, the revision pointer. States `research`, `writer`, then `published`, `rejected` or `unknown` | Unique `(topic, policy_version, take)` with take 1 to 3, UUID | Nonpersonal public supply; retained for correction, no account erasure |
| `content.asset_revisions` / `asset_provenance` | Immutable admitted consumer bytes / internal evidence and generation lineage | Asset + revision | Shared content; no account erasure |
| `reasoning.production_*` (0013, 0050) | The writer run, every possible paid attempt, and the refused answers kept 30 days for diagnosis | Stable writer run UUID | Harness retention and liability policy |

Lock order: production root → production job row → asset advisory lock → asset rows. Short
transactions freeze or apply data; no model or HTTP wait holds one. Every rejection and the final
write require their expected stage under the root and job lock, so a delayed delivery reports the
advanced job instead of acting on it. `--resume` continues the same frozen research and the same
writer run through the ledger after a crash. An unknown attempt stays unknown and is never resent.
A rerun reports the existing state; a terminal rejection stays rejected for its take. A changed recipe is
a new `SCROLL_PRODUCTION_VERSION` (and `WRITER_PROMPT_VERSION`), never an edit of an old job.

When a Scroll fails, `reasoning rejected` lists the refused answers with the validator's findings
(`packages/backend/src/reasoning/README.md`); that is where to look first.

Jobs: `content.produce-scroll` (above). Notices: none. Erasure: nonpersonal supply, nothing to erase.
Operator steps: `docs/v2/operations/scroll-production.md`.

The recipes the producer runs are the library plan in `../domain/library/` (one file per topic
system); `topics.ts` is only its index. The recipe key, the brief, the research pages and the
interactive block kind (`interactiveKind`) all come from the plan. Neither private research nor
provenance is reachable through content's client-facing read ports.

## Publication: topic attribution and coverage

`completeWriterPublication` is private to production and has no consumer/composition attribution
port. It requires the current live production scope, the locked writer-stage job and actual
successful `closeProductionRun`. After its publication callback stores the immutable revision and
marks the exact job published, unexported helpers match the current policy, target asset and
revision, explanation identity, admitted Scroll status, document/provenance hashes, model
production run and writer prompt version, successful primary/repair accounting identities and
the job's exact writer receipt. Provider/model must be the configured real MiniMax family; a
normal fixture transport/model, arbitrary editorial/model-kind or explanation-ID lookalike,
missing job, foreign lineage, incomplete job or contradictory metadata does not gain authority.
The helpers read no reasoning SQL, request bytes, raw answers or research text. Actual closure
and bounded accounting come through the existing harness within the same production transaction.

Two things are then written in that same transaction, both decided by code from the recipe in
`TOPICS` (the library plan in `domain/library/`, D-033):

1. **Planet.** The `0016` trigger already creates the exact revision's baseline discovery row.
   The hook projects one primary topic with weight 1 (the recipe's planet, for example
   `machine-learning.attention`) under `published-scroll-brief-taxonomy.v1`. Existing aggregate
   weight guards remain active.
2. **Coverage.** `admitRecipeCoverage` binds the recipe's facet (and optional supporting facet) to
   blocks of the stored document under the structural rule `scroll-recipe-coverage.v1`, and appends
   the first coverage head. A document with too few body blocks publishes without coverage and a
   `coverage_*` outcome is added to the job. See the content README, "Scroll coverage".

No immutable document/provenance bytes, personal encounters, activity, growth, series or
relationships change. Failure in either step rolls back writer closure, publication and metadata
together; same-run ledger replay recovers without resending a paid answer. Missing authority
remains unknown. Historical-published reconciliation is **unavailable**: completed old runs need a
separately named reasoning attestation read before any such capability can exist.

CI uses explicitly labelled transport identity stand-ins for positives and fault injection for
authority negatives; none is real provider or discovery journey evidence.

## Cutroom commission contract prerequisite (#240)

`commission-contracts.ts` is a backend-internal, pure prerequisite. It installs no service, job,
route, persistence, transport, grant or publication path. It leaves the three approved single-run
imports and their strict validator unchanged. The business run belongs to Content; external attempts,
protected requests and dispatch uncertainty belong to the shared Reasoning cents seam, with no model
role/token allocation reused. `CutroomExecution` and `ValidateCutroomRemoteChain` are declarations,
not implemented runtime capabilities.

`cutroom-commission.v1` freezes bounded original script + immutable public evidence excerpts,
retrieval timestamps, hashes and explicit claim/support bindings. It can ground a new original
script without claiming an old admitted Scroll/claimSources identity or semantic coverage. Embedded username/password URL credentials are refused. URL parsing does not prove public access;
actual source review remains separate. Structural support is not entailment, rights or truth review. Human exact-script/evidence review remains required.
Approval reference parsing and matching digest are data checks only; they grant no owner authority.
The opaque future verified owner capability must be separately admitted before any execution.

Lint requires 6–12 complete narration sentences, explicit listed claims, consistent criterion types,
exact excerpt hashes, no ending Sun, and a <=9-second per-sentence planning estimate at2.5words/s.
Exactly six is preferred. This heuristic cannot establish real TTS duration, merged-shot length or
witness-media conformance: a later actual plan/media gate must refuse oversized shots. Canonical
schema-parsed UTF-8 script JSON (including evidence and policy) defines the immutable script digest.
Request identity is `ks-reel-<first32 script SHA>-<take1..999>` under this named policy; the future
shared pool allocates each take. This function allocates nothing. A once-compiled v1 wire string
binds exact request/world/ceiling, omits internal sources/claim text,
and supplies SHA-256/byte count for protected storage. Never log or enqueue the string. A changed
script, evidence, policy or request identity changes its binding; redelivery uses stored bytes.

The future chain validator must bound16 unique remote runs, preserve the original request ID and
fresh parent/child status links, match result/record, verify keptFrom ancestry and selected/used gates,
and preserve engine labels. Engine auto-resume observations are not new caller POST attempts. A
failed parent does not prove finality. Pinned upstream cost fields do not yet establish all chain
aggregation semantics; cost remains explicitly unverified until reviewed accounting evidence exists.
No automatic sum/settlement or new<=75c allowance per child follows. Publication, corpus fingerprint,
source/framing/rights/media gates, exact-script owner approval, live fal balance and pool reconciliation
remain separate future requirements. No content/evidence/coverage/encounter is admitted here.


## Durable Reel commission B prerequisite (#240)

Content owns immutable public script/evidence/policy/package and original command hashes in reel_commissions, plus one Reasoning attempt reference. The unmounted makeCommission factory uses the real shared Cutroom root transaction, locks the business, and asks Reasoning public reservation ports; a trusted empty-by-default owner registry must match before any effect. Exact business replay checks the stored command and reads the existing attempt before compilation, so expired protected bytes are never reconstructed or replaced. New business, protected request, immutable pool intention and IDs-only job commit together. No take-increment loop, caller approval mint, provider dispatch, remote chain validation, publication, Supply binding or normal app/worker/HTTP consumer is implemented. Shared public business/attempt/accounting survives personal clear/erasure; private/personal inputs are rejected. All existing308 pure compiler and import semantics remain unchanged.

## Cutroom C1 concrete review and retained corpus (#240)

prepareCommissionReview returns a DRAFT from one actual public script using the unchanged A lint/compiler, with readable script/evidence, rights/framing/target references, exact request identity/hash/UTF-8 length, take, <=75c ceiling and fixed <=200c grant proposal. A draft claims no corpus verdict. The trusted makeCommissionReview.prepare scope/store seam reads and validates actual complete bounded metadata before sealing corpusSnapshotSha256 and corpusGate:clear into the concrete reviewSha. Supplied hashes/clear flags are rejected as preparation input. Preparation creates no business, attempt, pool intention or job and grants nothing. That concrete packet is ready before asking the human owner to approve it. Explicit human evidence is matched only through an initially empty composition-owned registry; a parsed reference, environment body, GitHub identity or merged PR cannot manufacture approval. Current generation, exact immutable Content business, packet, live approval and non-revoked review are rechecked before an execution intent. This source adds no normal producer/consumer or provider call.

CF63 compatibility preserves the old canonical JSON (recursively sorted keys, constructed array order and UTF-8 SHA256) and exact trim/whitespace-collapse/lowercase normalization. Template projection retains ordered narration claim counts, sorted role/criterion types, depiction/style/version and planVaryOn(null for A). Original argument projection retains the historical topic-world and sorted unique asset@revision sources; ordering world and public URLs never impersonate those fields. Original hashes are immutable. A mandatory separately named narration-bridge-v1 hashes the sorted normalized narration multiset; projection versions remain metadata outside legacy hash bytes. Any compatible template or bridge equality refuses. This deliberately may overreject and never proves semantic novelty. Policy/style/ID/source/order changes cannot reset the corpus.

Every historical fingerprinted Reel across availability/status/version belongs to the corpus. Historical duplicate hashes are legal distinct rows, with nonunique indexes. Actual complete metadata inventory, original-descriptor/hash verification and a separately reviewed trusted completeness manifest are required before activation; no manifest means corpus_unavailable, never complete-empty. The bounded first implementation accepts at most 1000 mapped rows, <=16384B each. Unmapped/unknown/partial/mismatched data refuses. The manifest commits all row values and descriptor mappings; a shared serialization lock also excludes every other admitted candidate, including revoked reviews. No import endpoint or source seed installs corpus data. Fourteen retained script inputs and the three existing import envelopes are different inventories, neither proves actual historical stamped DB completeness. Tests read the 14 inputs as source fixtures only; production never loads them or imports v1 architecture. A future actual importer must take the same corpus lock and preserve all original stamps/statuses. Rejected/revoked candidates are conservatively retained, never relabeled as generated Reels.

The dynamic snapshot commits trusted legacy completeness plus every ordered retained v2 row (strict supported packet/version, derived hashes, Content business/column correspondence, raw packet hash, human evidence reference and exact revocation timestamp). Unknown, malformed or mismatched rows refuse before novelty filtering, irrespective of their indexed hashes or status. The legacy limit is separately 1000 records x 16384 bytes (16,384,000 bytes); validated v2 packets are separately limited to 1000 rows and 8,388,608 bytes. Their combined accepted JSON metadata ceiling is 24,772,608 bytes, plus DDL-bounded scalar columns. Each scan fetches at most 1001 rows to detect overflow: v2 packet intake can reach 100,100,000 bytes before aggregate refusal (1001 x the 100000-byte DDL bound), and legacy intake can reach 16,400,384 bytes. Business request IDs are projected as NULL before materialization when over 128 UTF-8 bytes; identity checks refuse the row, without truncating or filtering it. Other selected business text has DDL bounds: hashes 64 ASCII bytes, fixed policy, approval reference at most 128 characters/512 UTF-8 bytes, and own package at most 65536 bytes. No partial snapshot is treated as complete. Shared corpus serialization and retained-row share locks fence concurrent admission/revocation. The verified computed template is compared for every mapped historical row even when its original template stamp is null; nullable original stamps remain unchanged.

Admission/recheck recompute that snapshot under the same root/business/corpus locking order and require exact equality to the human-reviewed packet. Only fully validated exact same-business packet replay excludes its own row, so insertion preserves its own replay digest while another admission advances the snapshot. Stale packets/approvals refuse. An existing business is checked before compilation: preparation reuses only validated stored review metadata (including after protected-byte purge), or refuses unreviewed/stale/corrupt history. There is no implicit refresh, reapproval, replacement, maintenance bootstrap or take change. Existing stale immutable reviews remain held for an explicit later protocol; C1 does not invent that authority.

## Disabled-root read-only preapproval (#240 D1)

`makeCommissionPreparation` is a distinct default-disabled factory with only `prepare`.
It uses the live read-only preparation scope and the existing store's `prepareReadOnly`
method; no human registry/admit/recheck/business/attempt/dispatch method is exposed.
Its trusted completeness list starts empty. Missing/unproven completeness is
corpus_unavailable, never complete-empty. Normal composition supplies no binding.

The read-only and locked C1 paths share one bounded row projection, full canonical
packet/column/hash validation and snapshot digest algorithm. Locked preparation,
admission and recheck retain root/business/corpus serialization and SHARE locks.
Read-only preparation instead uses one consistent repeatable-read snapshot, no row or
advisory lock. The existing disabled root/generation, every mapped legacy row and every
retained v2 review across versions/statuses are read consistently. The same1000+1 scan
bounds, separate16,384,000B legacy/8,388,608B accepted v2 caps and24,772,608B combined
accepted JSON ceiling apply; raw intake bounds remain16,400,384B/100,100,000B before
aggregate refusal. Oversized business request IDs still project NULL before materialization.
No row is silently skipped/truncated and no fingerprint policy/version resets history.

Fresh public candidates compile once to hash/length metadata before any B business.
Existing businesses use only exact retained review metadata before compilation, including
when protected bytes were purged; absent/corrupt/stale metadata refuses, never rebuilds,
refreshes or replaces the request. The returned clear packet is only true for its snapshot,
not reserved novelty or human approval. Another admitted/revoked review or root change can
make it stale; final locked C1 admission/recheck remains mandatory and unchanged.
Actions fixtures label completeness and human attestations fictional, prove actual read-only
write refusal, separate capability/lifetime/markers, exact zero effects and stale snapshot
refusals. Actual complete corpus mapping, per-script human evidence, fal/pool/sole-writer
preflight, dispatch, media publication and Supply completion require separate accepted work.

## Pure pinned Cutroom chain metadata (#240)

`validatePinnedCutroomChain` is a pure, unmounted data validator for the exact upstream revision
`94ee04a1c48069c293203de326d4801360ca6158` and wire1. It accepts at most an original and one
engine-created child. The general A16-run declaration, once-compiled request and three old single-run
imports remain unchanged. A supplied revision/hash/time is data, never proof of a running engine,
sole writer, human approval, provider invoice or permission to settle a pool order.

The internal input carries expected attempt/request metadata, explicit validation time, and opening,
result, record and closing observations with explicit times. Each document is a serialized sanitized
projection, bounded to262144UTF8bytes before JSON parsing, then depth12/12000nodes before deep schema
validation/hashing. The eight-document total is at most2097152B; record limits are1000 pictures and
1000 takes,32checks per piece. All observations fit a30s collection window; closing follows the
result and record, with unchanged terminal identity/topology/sequence. Unknown or incomplete data
holds. The expected request ID must match A's script/take identity, but the HTTP wire cannot itself
attest the protected body digest/world/script. C2 must bind those facts separately.

These projections are NOT new HTTP fields. Future C2 must parse the full immutable wire union,
including failed-parent results, then apply CF10 before serialization. Projection drops free-form
messages, paths, headers and raw degradation reasons (which become reasonSha256). Record has no
requestId. Canonical projection hashes are not raw-response hashes. The old GET reader deliberately
accepts only completed video and cannot serve as this future full-terminal collector.

Membership of a chain needs fresh reciprocal resumes/resumedBy, one original and one optional tip;
caller-created resumes are outside this engine-only profile, so a child requires a failed parent.
Every copied picture/take must match its immediate parent's immutable fields and checks; only chosen
and used may differ. Validate all retained pieces, not just selected ones. Selected video metadata
requires actual picture steps1technical/text/witness/reconcile and used-take gates2/3/4/5, no selected
failure, matching stills/degradations and honest held-shot coverage. Unpictured used takes remain valid.
Accept-with-label stays labelled and all attestation remains engine-attested, not independent.

Complete engine accounting is distinct from video eligibility. Sum each distinct run's OWN safe cost
once, including a failed original; copied pieces and estimates add nothing. Report overage without
clamping or granting another75c; unsafe sums hold. A terminal failed chain can have complete reported
cost with no video candidate. Outputs contain closed codes, digests/counts, costs and finite label
outcomes, never raw identifiers/provider strings/URLs. They mint no receipt, accounting/human
capability, media/publication eligibility, Supply completion or retry/new-take authority. Actual
funds/pool/profile/corpus/approval/transport/media gates remain separately allocated work. Authored
unit fixtures run only in Actions; no real resumed chain, provider billing or deployed journey is
claimed by this prerequisite.

## Bounded GET-only Cutroom collector (#240 C2)

`makeCutroomChainCollector` is disabled without explicit trusted settings. No normal
composition calls it. It has only `collect`: fixed loopback HTTP GET readiness,
request lookup and run status/result/record routes. There is no POST, resume/cancel,
billing/pool/credential access, DB/store/job, artifact opener or publication method.
The existing single-run importer, its video-only result method, approved saved results,
A16 declaration and all vendored wire bytes remain unchanged.

Full canonical wire-v1 schemas parse every terminal arm, including the failed original
of an automatic child chain. Raw response bytes are bounded before JSON parsing; an
iterative depth12/node12000 guard precedes recursive wire validation. Limits are fixed:
10 GETs/delivery,262144B/response,2621440B total raw intake,5s/call,30s total. UTF8 is
strict. Redirects/retries are disabled, finite errors discard all reply/error/header
text, and no configurable limit can raise these ceilings. The normal one/two-run paths
use5/9 GETs including readiness. No operation polls or sleeps while holding a transaction;
the existing transaction marker refuses any network access inside a marked transaction.

Opening statuses may name the original or newest child. The bounded traversal checks
request identity and exact reciprocal links, fetches each full terminal result/record,
then closes EVERY status after ALL records. A running/delayed child, changed closing
sequence/topology,404,timeout or missing proof remains pending/unknown; it never resends
or creates a take, releases liability or silently refreshes. Under the94ee source profile,
automatic child creation occurs in the SAME transaction finishing the failed parent;
15 minutes delays its job, not its row. Running-source/sole-writer correspondence remains
an external prerequisite, never inferred from readiness or supplied profile metadata.

Raw bodies are transient private input. Explicit allowlists serialize the eight strict
sanitized projections for the accepted pure validator; paths, video URLs, freeform detail,
rule prose and headers are discarded, degradation reasons become SHA256. Checks and labels
are never dropped to pass gates. Returned values contain only the finite validator report,
raw-body-digest aggregate, received time and bounded counters; no raw run/piece IDs or eight
documents are exposed or persisted. The evidence digest is not a provider invoice, remote
body attestation or approval capability. Per-response and aggregate projection bounds remain
separate from raw intake/transient parsing memory. Unsupported shapes refuse, never truncate.

Supplied profile/time/digest expectations are trusted composition data, not actual engine
installation evidence. Freshness is rechecked after every HTTP wait and at closure; stale,
future or reversed clocks refuse. Actual profile/data epoch/sole writer, full-corpus/human
exact-script approval, fresh sufficient fal funds, pool grant/principal/receipt, acknowledged
dispatch intent, onePOST/unknown recovery, durable snapshot/accounting integration, verified
media/publication and Supply completion still require separate reviewed work. No cost-complete
report settles a claim or weakens CF62's whole-ceiling hold on import failure. Authored fake-HTTP
and canary fixtures run only in Actions; no real Cutroom/provider or live media result is claimed.

Canonical readiness status/body pairs are200/true and503/false only; false readiness
stops before lookup, contradictions/private extra fields refuse. A fixed deadline races
both the initial HTTP promise and every explicit body-reader wait. Socket abort and stream
cancellation remain best-effort cleanup, never an awaited prerequisite to returning the
finite deadline result; late replies cannot become observed reports. The actual stalled-body
regression is retained with its unchanged suite timeout.

## Durable sanitized chain evidence (#240)

The separately selected `makeCutroomChainSnapshotCollector` shares the existing GET/parser/projection
sequence and fixed deadlines/bounds. Default-disabled settings perform no work. The existing report-only
collector still discards every document; the new port exposes only the strict sanitized four/eight
projections, collection/profile references, times and raw-body aggregate/counters. URLs, headers, raw
reply bodies, freeform details and degradation reasons do not escape; retained reasons are digests.
Source/profile expectations and fixture hashes are not an actual engine/funds/human attestation.

`makeCommissionChainSnapshots` is an explicit default-disabled factory with no normal API/worker
binding. It validates serialized byte/depth/node/semantic limits outside the write transaction, derives
cost/classification itself, then enters the existing root -> exact business -> retained attempt
accounting scope. Reasoning's public scoped ports own immutable execution/receipt/observation metadata;
Content never queries those tables. Request IDs use bounded projections and claimed/bound timestamps
retain all six fractional digits. No protected request, permit, POST, pool operation, media opener,
publication or attempt engine is added. Old/disabled-generation liability metadata can be retained
without reviving approval, purged bytes, another take or dispatch permission.

World0033 adds two immutable shared Content tables. A snapshot has a canonical <=8192-byte versioned
header, ordered document hashes/byte vector and exact execution identity. Each document is <=262144
UTF8 bytes; exactly4 or8 documents total <=2097152 bytes. DB SHA/byte checks and a deferred completeness
trigger prevent partial commits even on adapter bypass. Thirty-two unique ordinal/digest slots bound
history to <=67108864 document bytes/attempt plus bounded headers/columns. The33rd is held/refused;
there is no eviction, overwrite, bootstrap or personal-erasure cascade. Read at most33 bounded headers
and one exact known snapshot/observation/eight documents; corrupt/unknown versions or correspondence
refuse. Raw intake remains separately <=2621440 bytes, not a claimed2MiB total memory ceiling.

The new complete-path observation key is the **snapshot digest**, distinct from the raw-body aggregate
and existing semantic chain digest. Its unique observation ID resolves one Content header for the
unchanged IDs-only accounting work. Exact replay returns original IDs without another job; different
later evidence cannot replace earlier evidence. Header/documents, existing C1 observation, pending
accounting intent and pg-boss job commit atomically. Post-write refusals throw through the actual scope
and are mapped only after rollback. Lost COMMIT ACK never causes financial action; an exact replay/read
recovers durable IDs. A historical read revalidates at its sealed capture time and does not make that
evidence current or reconstruct request bytes. Reported safe cents and accept-with-label outcomes stay
honest, including overage and video-unavailable chains. All whole-ceiling liabilities remain held;
settlement/import/disposition, actual profile/funds/pool authority, human scripts and CF62 are later gates.

The connected commissioning facade captures each parsed review packet per invocation, admits it
with the exact new B reservation, and tracks durable work in that same transaction. The only POST
consumes the acknowledged C1 permit once and sends the protected original bytes unchanged. A lost
intent COMMIT, POST acknowledgement, refusal or timeout leads to retained liability plus bounded
GET reconciliation; it never authorizes a new take, resume, cancel, release or blind resend.

A collected0033 closed chain is revalidated before import. Distinct original/one-auto-child OWN
costs form one stable `cutroom-financial.v1` report; it includes exact receipt UUID/six-fractional
UTC times and sanitized result/record document digests, but excludes collection timestamps and
publication IDs. Unknown/incomplete chain cost is never invented. Nonvideo, overage, review/media
or import failure leaves the full claim open. Known exact terminal reports use the additive
reviewed evidence-only pool protocol; only a verified publication may settle actual cost. No
clamping, refund or allowance reset is performed.

`makeReelCorpusImporter` imports trusted complete legacy metadata without replacing, deleting or
filtering history. Existing retained v2 reviews remain automatically inventoried by the owning
review store. A complete legacy manifest and individual HUMAN approval are separate mandatory
inputs. A clear corpus result alone cannot dispatch. Root-driven immediate delivery reports
`held`, `post_unknown`, `accounting_pending` or concrete observed/publication/accounting progress;
`accounting_confirmed` can mean an active evidence hold and is not a claim-settled assertion.

Upfront budget activation boundary: wire v1 alone does not prove a shared chain cap. The
pinned Cutroom94ee04a1 source does: `reelSpentCents` is original plus child OWN spend, the child
copies the original request unchanged, every image/video/narration send guards that total against
its original `budgetCents`, and resume admission checks prior spend plus child estimate. A second
child/resume-of-resume is refused. This intended engine-accounted bound assumes the matched real
adapter/guard rates, token-plan-covered model/speech, one-hop image profile, serial record-before-
next-send and one writer. Actual installed revision/profile/rates, lease suitability and complete
send/receipt state remain separately mandatory Root activation facts. Unknown or unexpected
provider billing is not proved away; the exact overage hold remains defensive accounting, not
retroactive authorization. Source never widens, refunds or clips the approved ceiling.

## CF62 receiving production boundary (#373)

The internal `cutroom-receive.v1` envelope is not an HTTP/browser approval contract. Its external
SHA256 binds exact UTF8≤100000B; closed schemas reject unknown fields, invalid financial totals,
noncompleted final chains, same-world targets, changed document/media identity and a new UUID for
an existing publication/target. It contains public immutable origin provenance, exact six-fractional
binding timestamps and original plus at most one child OWN costs, never pool credentials,
provider responses/URLs, prompts or private staging paths. `receiverChargeCents:0` is provenance,
not an origin accounting report and never a settlement instruction.

`makeCommissionReceive` only accepts injected receiving scope/store, Root registry and local media
ports. Reads of the external registry precede transactions; the captured certificate is rechecked
after root/operation/asset waits and at final commit. Media proofs are private, single-use and
short-lived, bound to exact payload/generation and actual probed bytes. No Cutroom HTTP or paid port
is reachable. An unknown database acknowledgement is reconciled with the SAME body; no inline
replacement or financial compensation runs. Already admitted receipt replay is historical and
cannot restore withdrawn/corrected content. A Root current-source attestation is essential because
this bounded operator handoff does not invent an automatic revocation bridge.
