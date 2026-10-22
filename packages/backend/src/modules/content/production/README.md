# Scroll production

Writer roles belong to content (blueprint §§11,15); `production/` owns their briefs, schemas,
semantic checks, frozen research and application. `infrastructure/research` owns the public HTTP
boundary. The shared reasoning engine retains transport, admission and the external attempt ledger.

| Stored table | Role | Main query | Lifetime |
|---|---|---|---|
| `content.scroll_production_runs` (0015) | Authoritative, private topic/version job; research pages/passages, accepted claims, code-only outcomes, draft and revision pointer | Unique `(topic, policy_version)`, UUID | Nonpersonal public supply; retained for correction, no account erasure |
| `content.asset_revisions` / `asset_provenance` | Immutable admitted consumer bytes / internal evidence and generation lineage | Asset + revision | Shared content; no account erasure |
| `reasoning.production_*` (0013) | Role runs and every possible paid attempt | Stable claims/writer run UUID | Harness retention and liability policy |

`makeProduceScroll` reserves a topic/version, retrieves code-selected public pages, freezes original
plain-text passages with content-derived IDs, asks the claims role, asks the writer, and publishes.
The claims role selects offered evidence IDs; code hydrates exact stored characters. Both role
schemas include semantic checks inside the harness's single repair allowance: at most two claims requests plus two writer requests, **four total**.
Writer output is canonical `scroll-draft.v1`; `compileDraft` checks support bindings, numbers, copying,
structure and simulation honesty, then `admitDocument` checks the exact stored consumer bytes. Code
also refuses source names/web addresses in reader text and unbound narrative blocks. Numerical
checks and exact quotations do not prove semantic entailment: human sampling is still required.

No jobs are registered yet: the worker operator triggers this bounded sequence. Lock order:
production root → production job row → asset advisory lock → asset rows. Short transactions freeze
or apply data; HTTP/model waits never hold them. Each stage closes its harness run in the same
transaction as its accepted domain effect. Every rejection and final write requires its exact expected stage under the root and job lock.
A delayed research/closed-role delivery reports the advanced job instead of rejecting or invoking
its next stage; a concurrent/late result cannot apply after a terminal state. `--resume` explicitly continues the same frozen research, accepted claims and stable role
run IDs through the ledger after a crash; no new business run or hidden model retry is created.
An unknown attempt stays unknown and is never resent. Ordinary reruns report existing state;
terminal rejection stays rejected. A changed prompt, source list or policy requires a reviewed
version bump, never editing the old job or published revision.

Topic explanation identities are `legacy-cutroom-seasons-v5`, `legacy-cutroom-tides-v4`, and
`legacy-cutroom-greenhouse`, exactly matching the approved Reel import. The frozen v1 scripts are
continuity references only. No v1 Scroll or authored example is presented as generated content.
Neither private research nor provenance is reachable through content's client-facing read ports.

## Prompt repair and version boundaries

A real local v1 run completed its claims request, then both writer attempts were refused with
`OUTPUT_NOT_ONE_JSON_OBJECT`; no asset was published. The invalid reply text was not retained,
so its syntax cause is unknown. The catalogue contains reference grammar rather than literal
JSON; v2 makes that distinction explicit and adds one `JSON.stringify`-generated fictional syntax
example. This is a bounded prompt correction, not evidence that the earlier model copied grammar
or that the revised prompt will succeed. Parsing, schemas, admission and repair limits are unchanged.

| Identity | v1 | v2 | v3 | v4 | v5 | v6 | v7 | v8 |
|---|---|---|---|---|---|---|---|---|
| Job policy / unique topic-version key | `scroll-production.v1` | `scroll-production.v2` | `scroll-production.v3` | `scroll-production.v4` | `scroll-production.v5` | `scroll-production.v6` | `scroll-production.v7` | `scroll-production.v8` |
| Claims role version | `scroll-production.v1` | `scroll-claims.v1` (unchanged v1 instructions/schema) | `scroll-claims.v2` (selection only) | Unchanged | Unchanged | `scroll-claims.v3` (native object carrier) | `scroll-claims.v4` (advisory input shape) | Unchanged |
| Writer role and provenance prompt version | `scroll-production.v1` | `scroll-writer.v2` | `scroll-writer.v2` (unchanged) | `scroll-writer.v3` | `scroll-writer.v4` (semantic repair feedback) | `scroll-writer.v5` (native object + original prose) | `scroll-writer.v6` (advisory input shape) | Unchanged |
| Research policy / draft DSL | `public-research.v1` / `scroll-draft.v1` | Unchanged | Unchanged | Unchanged | Unchanged | Unchanged | Unchanged | Unchanged |
| Evidence candidate recipe | None | None | `quote-candidates.v1` | Unchanged | Unchanged | Unchanged | Unchanged | Unchanged |

All four rejected v1/v2/v3 jobs, their stable run IDs and eleven attempts stay untouched. A reviewed v4 invocation
creates a different job and role runs; it is not a resend or resume of an earlier version. It still
needs an explicit coordinator allocation and costs at most four requests, with the same
4,000/12,000 role ceilings.
The synthetic example uses `example-only-claim`, outside the claims role's accepted `claim-`
namespace; it cannot be authorized by real offered claims. CI checks its JSON/schema/compilation
with fictional fixture evidence and its refusal under production evidence. It is not library content.

## Selection-only evidence in v3

A real v2 claims primary failed its truth-state enum; its repair failed two exact-quote checks.
Only safe paths/codes were inspected, so the rejected values and text edits are unknown. The v3
correction removes both free statement generation and quote transcription from this role.

Code first verifies the frozen page/passages and their content hashes, then derives at most 32
`quote-candidates.v1` entries. Each is a whole paragraph or a group of complete sentences,
40–600 original characters, with exact UTF-16 offsets and a hash binding policy, source URL,
page/passages and text. Long paragraphs are partitioned only at conservative sentence boundaries;
look-ahead keeps a short final caveat with a neighbouring sentence. Unpartitionable text, incomplete
long tails, duplicate identities, fewer than four candidates or pool overflow refuse before model
admission. No text is clipped, normalised or rephrased to fit, and no oversized pool is truncated.

The model sees the actual bounded ID/text pool and selects four to eight distinct offered IDs.
Its strict JSON has only `candidateIds`. Within the same one-repair schema, code rechecks pool
integrity/membership, then hydrates each statement and quote to the identical original substring,
assigning a hash-derived `claim-` ID. `documented` means a direct source quotation; it does not
mean proven world truth or verified entailment. The role cannot author synthesis, interpretation
or modelled claims. Relevance, faithful selection and final teaching quality still need human review.

The harness retains/revalidates the raw selection, not the transformed hydrated claims. The
content job stores those hydrated claims privately. Resume deterministically rebuilds the pool
from frozen pages and verifies the stored claims before writer admission. The writer creates
original prose using the separately versioned writer recipe; all research participates in the unchanged copy check,
and number, honesty, binding, parser and admission checks remain in force. CI fixtures cover raw
selection replay, source/claim tampering, foreign/duplicate IDs, long caveats, multiple sources,
max-four repairs, and byte preservation of terminal v1/v2 rows. No fixture is model generation.

## Compact writer recipe in v4

The real v3 greenhouse claims request succeeded. Writer primary was valid JSON but failed array
validation at masked paths; repair failed internal JSON syntax with a separator-category diagnostic.
Invalid answers were not retained, so neither exact fields nor punctuation are known. A smaller
recipe may reduce mistakes; CI does not establish a successful real generation.

Writer v3 asks for a finished 2–3 minute explanation (roughly 450–600 words), three short sections,
paragraphs, one useful comparison or toggle diagram, and a closing limits callout. The code's
computed measure and 2–8 minute admission contract are unchanged. Greenhouse uses a comparison
with nested RichText arrays; seasons/tides use useful bounded interactive states. The full canonical
catalogue remains authoritative, and each request includes exactly one matching JSON.stringify
fictional shape example. Nothing authored is published as generation.

The writer wire schema is directly exported `ScrollDraft.superRefine`: canonical arrays are
required before compilation, so schema-declared outer paths are available to existing safe repair
feedback. This removes only content's writer preprocessing wrapper; global compiler normalization
and strict JSON extraction remain unchanged. Copy-nine, binding, numeric, honesty, source/privacy,
interactive and admission checks still use the same one repair. Role identity and failure brake are
unchanged; writer provenance records `scroll-writer.v3`. CI preserves synthetic historical terminal
job/attempt bytes and tests both valid modes, malformed arrays and unchanged refusals.

## Fixed semantic repair feedback in v5

The real dev v4 greenhouse job completed its claims request, then writer primary and repair failed
`OUTPUT_SCHEMA_MISMATCH`. Only `custom` codes and masked paths were retained. Failed drafts are
unavailable, so the exact rejected rule is unknown; no copy, numeric or other cause is inferred.

Policy `scroll-production.v5` and writer/provenance version `scroll-writer.v4` change the repair
feedback behavior: the writer declares the existing static producer `REPAIR_HINTS` plus three fixed
content checks (`reader_block_unbound`, `reader_source_or_url`, `interactive_required`). Its custom
Zod issues attach `params.safeCode` only for those own allowlisted codes. The shared harness uses
the corresponding fixed code/hint with its unchanged schema path masking and eight-issue bound;
it never reads custom messages, draft values, source excerpts or unknown path names. The internal
`admission_refused` invariant remains undeclared and masked as `custom`, without a repair hint.
Claims remain `scroll-claims.v2` and do not opt into semantic feedback. Role IDs are unchanged.

The primary writer request recipe and all schema, compilation, copy-nine, numeric, binding, length,
DSL, interactive and stored-admission assertions are unchanged. The same primary plus one repair
per role still costs at most four calls per topic. No failed raw draft is retained. The version
change records an actual feedback contract change, never resets the daily ledger, role failure
brake, production generation or external allowance, and does not authorize a call. New invocation
requires a separately reviewed coordinator allocation; terminal v1–v4 jobs/runs/attempts stay
immutable. CI preserves five historical job shapes/fourteen attempts byte-for-byte and exercises
actual writer semantic refusal → safe stored issue → fixed repair context → replay without resend.
This is fixture evidence; no real generation success is established by this change.

The publication hook imports the current policy/writer constants in addition to all existing
scope, closure, receipt and admission checks. No historical reconciliation or backfill is added.

## Native object carrier and original prose in v6

The latest real dev v5 claims primary selected fewer than four IDs; its single repair succeeded.
Writer primary parsed but failed `copied_passage` at a masked reader path: at least nine consecutive
words matched the supplied material. Its repair failed one-object JSON handling, with only a bare
object prefix, `unexpected_token` category and 8,147-character count retained. Invalid drafts were
not stored; the exact copied passage and malformed token are unknown.

Policy `scroll-production.v6` uses the reviewed shared `single-tool-object` format for both
`scroll-claims.v3` and `scroll-writer.v5`. Both primary and repair submit one native object through
the fixed `submit_output` data carrier; it executes no action and creates no tool interaction loop.
The writer asks for freshly composed sentences from the selected documented claims, preserving
their technical meaning and caveats. A copy refusal asks for rewritten prose and corresponding
passage anchors, without omitting substance or evading the check across spans/blocks. This is
prompt guidance, not evidence of improved actual model output or semantic entailment.

The [MiniMax Messages reference](https://platform.minimax.io/docs/api-reference/text-chat-anthropic)
and [published ToolChoice schema](https://platform.minimax.io/docs/api-reference/text/api/openapi-chat-anthropic.json)
document only `auto` choice. The model can choose an invalid reply. There is no forced-name or
schema-decoder guarantee, response-format mode, schema conversion, text fallback or JSON salvage.
The reviewed M3 adapter accepts exactly one correctly named tool with object input and a conclusive
tool stop, no mixed text or extra tools. Unsupported transports/models refuse before reasoning
reservation/quota/dispatch. All other roles with no opt-in retain their historical hp2 bytes.

Stable role IDs, generation, research, candidate selection, min-four claims, strict JSON/Zod,
canonical DSL, copy-nine, numeric/honesty/support binding, privacy, publication admission, daily
brake and all spend/unknown/replay rules are unchanged. At most two claims calls and two writer
calls remain possible. The new job policy and role versions record actual format/instruction
changes; they do not alter or resume terminal v1–v5 jobs, old attempts, receipts or protected bytes.
That version's publication attribution requires v6 job lineage and v5 writer provenance automatically
through the same imported constants. No runtime activation, new allowance or call is authorized.

CI uses authored HTTP responses through the real reviewed M3 encoder/parser and production harness
to exercise both role primaries/repairs, native min-four/copy refusals, exact new lineage, private
safe feedback, stored bytes, max-four accounting, terminal/unknown replay and unsupported models.
Historical synthetic v1–v5 job/attempt snapshots stay byte-identical. Such fixtures establish
protocol/application behavior; actual provider selection, three generated Scrolls (two interactive)
and quality review still require separately allocated real runs and connected reading evidence.

## Advisory native input shape in v7

Policy `scroll-production.v7`, claims `scroll-claims.v4` and writer/provenance `scroll-writer.v6`
add `nativeOutputSchema: zod-structural.v1` to both existing native-object roles. The reviewed
shared harness derives structural input from their existing Zod schemas, uses `hp4-tool-schema`
framing and includes the bounded canonical schema in the same fixed `submit_output` data carrier.
Claims still submit the pre-transform `candidateIds`; code still hydrates exact offered quotes.
The writer's complete canonical ScrollDraft arrays/fields are described without copying a DSL.
Both primary and the existing single repair carry the same structural schema; the full encoded
request stays within the unchanged 100000-byte limit or refuses before reasoning admission.

This is advisory guidance, not constrained decoding or semantic truth. Custom refinements, exact
source/selection checks, min-four, copy-nine, binding, numeric/honesty, compiler and stored-document
admission remain unchanged. Role instructions, the three existing topic recipes, stable role IDs,
4000/12000 output ceilings, max-four attempts, daily caps/brakes, generation and unknown/replay
rules are unchanged. No actual failed v6 draft is available or reconstructed here.

The unique v7 job key creates new lineage; it never rewrites or resumes v1–v6 terminal jobs,
provenance, attempts or protected bytes. Publication uses the existing imported policy/writer
constants, so new attribution requires v7/v6 lineage and rejects previous native versions.
CI uses labelled fake HTTP through the real M3 encoder/parser and real PostgreSQL to check full
primary/repair schemas, bytes/hashes/accounting, exact new publication lineage, null invalid drafts,
one repair and retained historical snapshots. Fixtures are not generated content or real provider
acceptance. This source change authorises no call, allowance, role-cap reset or runtime activation;
a reviewed operator profile and any missing owner allocation remain separate work.

## Coherent explanation recipes in v8

Policy `scroll-production.v8` adds three code-owned recipe keys under the same existing
`earth.greenhouse-effect` primary topic. Each has an independent static asset ID and explicit
explanation identity. The original `seasons`, `tides`, and `greenhouse` keys, scripts, briefs,
source URLs, asset IDs and Reel-shared explanation identities remain exact. Their required
interaction values remain true, true and false. `TOPICS` now declares explanation identity and
interaction explicitly; the producer uses that value for both writer validation and compilation.
No new recipe inherits a Reel identity, series relationship or semantic coverage map.

| Key / explanation identity | Intended teaching question | Required interaction | Bounded source list |
|---|---|---|---|
| `greenhouse-radiation` / `earth-greenhouse-radiation-paths-v1` | Follow reflection, absorption and emission along incoming/outgoing radiation paths | Selectable physical-process diagram frames with accessible text; no time simulation | NASA radiation budget + greenhouse FAQ |
| `greenhouse-balance` / `earth-greenhouse-system-balance-v1` | Distinguish internal redistribution from energy crossing the whole-system boundary; compare equilibrium and imbalance | Qualitative balance/imbalance diagram states with accessible text; no prediction | NASA energy budget + greenhouse FAQ |
| `greenhouse-limits` / `earth-greenhouse-analogy-audit-v1` | Audit useful versus misleading blanket inferences and natural versus strengthened context | Comparison or disclosure; no interactive requirement | NASA radiation budget + greenhouse FAQ |

The analogy audit deliberately excludes another complete radiation-path/balance tutorial. It
still overlaps background ideas in the unchanged broad greenhouse overview: new keys, titles,
formats and IDs cannot establish conceptual variety. After actual generation, editorial review
must check all three outputs against each other and the old overview for distinct explanatory
work, faithful support, caveats, useful interaction and absence of redundant retelling. Exact
coverage-map approval remains separate and requires actual admitted bytes. Recipes, fixtures,
publication metadata and primary topic attribution never seed trusted coverage or form geography.

The investigation used the actual `public-research.v1` extraction and unchanged candidate builder
on unauthenticated public pages. The retained radiation-budget pool had 15 candidates, FAQ 7 and
energy-budget 20. Thus radiation+FAQ had 22 and energy+FAQ 27; the 35-candidate energy+radiation
combination and 33-candidate climate-causes page were refused by the unchanged 32 limit. Nothing
is clipped or a bound raised. Fetches remain live and bounded: different future extracts can
refuse, and these counts are dated investigation evidence, not a runtime promise. The retained
energy-budget extract ended before later greenhouse sections; those unseen sections confer no
writer authority. Historical numerical estimates must not be represented as current measurements.
The briefs forbid temperature forecasts, invented calculations/timescales and glasshouse experiments.

Forward migration `0026_scroll_recipe_units` extends only the closed job recipe-key constraint
from immutable 0015, after Geography 0025. It inserts no job, asset, personal evidence, semantic
approval or operation grant and rewrites no historical row. Unknown keys still refuse in the
operator parser and database. Old workers continue recognizing only their own keys.

Claims v4, writer/provenance v6, hp4 advisory schema, role instructions, strict validators,
min-four, copy-nine, support/honesty checks, canonical compilation/admission, 100000 request bytes,
4000/12000 output ceilings, max-four attempts, one repair per role, stable roles, generation,
daily brakes and unknown liabilities remain unchanged. The new policy records changed prepared
recipe context; no v1–v7 job is rewritten or resumed. Publication uses the existing private
current-version hook, so only genuinely completed new publications can project the shared topic.

CI uses authored bounded context (matching the investigated pool counts/text sizes, without
committing full public pages), the real M3 encoder and labelled PostgreSQL/publication stand-ins.
It checks full primary/repair request shapes/bytes and retained refusals, all six identities and
interaction values, closed unknown keys, three exact new publication lineages under one canonical
topic, and unchanged historical snapshots. This establishes source/protocol behavior, not generated
content, semantic variety, provider acceptance, UI reading or formation. No call, allowance,
role-cap/day reset, deployment or live registry seed is authorized by this source extension.

## New-publication topic authority

`completeWriterPublication` is private to production and has no consumer/composition attribution
port. It requires the current live production scope, the locked writer-stage job and actual
successful `closeProductionRun`. After its publication callback stores the immutable revision and
marks the exact job published, an unexported helper matches the current policy, target asset and
revision, explanation identity, admitted Scroll status, document/provenance hashes, model
production run and writer prompt version, successful primary/repair accounting identities and
the job's exact writer receipt. Provider/model must be the configured real MiniMax family; a
normal fixture transport/model, arbitrary editorial/model-kind or explanation-ID lookalike,
missing job, foreign lineage, incomplete job or contradictory metadata does not gain authority.
The helper reads no reasoning SQL, request bytes, raw answers or research text. Actual closure
and bounded accounting come through the existing harness within the same production transaction.

The `0016` trigger already creates the exact revision's baseline discovery row. Only then does
this hook project one code-owned primary topic with weight 1 and a single facet:
`earth.seasons`, `earth.tides`, or `earth.greenhouse-effect`, under
`published-scroll-brief-taxonomy.v1`. Existing aggregate weight guards remain active. No immutable
document/provenance bytes, personal encounters, activity, growth, series or relationships change.
Projection failure rolls back writer closure, publication and metadata together; same-run ledger
replay can recover without resending a paid answer. Missing authority remains unknown.

Historical-published reconciliation is **unavailable**: completed old runs need a separately named
reasoning attestation read before any such capability can exist. All four actual historical jobs
are rejected, so no known generated publication is omitted. CI uses explicitly labelled transport
identity stand-ins for positives and fault injection for authority negatives; none is real provider
or discovery journey evidence. The publication projection itself needs no SQL change; v8 extends only the closed recipe-key constraint in forward migration 0026.

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


## Bounded writer feedback in v9

Policy `scroll-production.v9` and writer/provenance `scroll-writer.v7` record a real instruction and
feedback change. Claims remain `scroll-claims.v4`; the fixed native carrier, hp4 framing and
canonical structural ScrollDraft input remain unchanged. Every primary/repair requests the complete
required object with native `sections`/`bindings` arrays. The writer distinguishes its strict span
arrays from compiler convenience notation and states combined canonical text limits and whole-text
trimming without changing those checks.

The writer opts into only the two new core-owned intrinsic RichText codes, `rich_text_too_long` and
`rich_text_not_trimmed`, with fixed module-owned hints. They distinguish combined-length overflow
from empty/outer-whitespace concatenated text. Unknown/custom issue messages and values remain
hidden; shared schema-path diagnostics retain later union branches under fixed privacy/work bounds.
This improves future feedback. The real rejected v8 radiation answer is unavailable: its masked
nested fields and exact RichText cause are not reconstructed or retrospectively classified.

CI uses authored native HTTP objects through the real M3 encoder/parser and disposable PostgreSQL:
nested optional-object and RichText refusal → one complete valid repair, terminal non-array repair,
null failed outputs, no third writer attempt, no fifth total request and no replay dispatch. Existing
historical v1–v7 snapshots and new terminal v8 issue/request snapshots stay byte-identical. Both
interactive/noninteractive modes retain strict arrays, min-four claims, copy-nine, number/support,
honesty, privacy, interaction and admitted stored-document checks.

All recipe keys/briefs/pages/asset+explanation identities, stable role IDs, generation, cumulative
failure brakes, token/request/output ceilings and unknown-liability ledgers remain unchanged.
A new policy is not a cap reset or a retry grant. No SQL, operator activation, allocation, reservation,
provider request, default or runtime permission changes here; a later operation needs separately
reviewed exact source/release/profile and budget authority. Fixtures do not prove provider success.

## Canonical production profiles in v10

Policy `scroll-production.v10` / writer `scroll-writer.v8` changes the actual production input
contract to a strict subset of the unchanged canonical `scroll-draft.v1`. The interactive profile
selects paragraph/diagram/callout with canonical toggle interaction and two to four frames; the
comparison profile selects paragraph/comparison/callout with two columns and two points each.
Both retain canonical passage/header/heading/block bindings. Non-text accessibility and fallback
fields are required. The profile selects original exported canonical schema nodes and narrows
through public Zod APIs; it does not copy fields, coerce strings, introduce a DSL or change core
Scroll schemas. Root/section array bounds stay canonical. Full compilation, support, copy-nine,
number/honesty checks, min-four claims, actual interaction and computed two-to-eight-minute
admission remain authoritative.

The tool's actual advisory input schema is now the selected structural reference. The production
prompt omits the full general-purpose catalogue and compiler convenience notation, retaining one
matching authored fictional JSON example. That example cannot be admitted under actual offered
claims and is never product content. Other users of the full catalogue/schema retain all16 types.

The real v9 radiation job was rejected after claims succeeded and both writer attempts reported
non-array-contract failures at sections/bindings. Failed raw replies were not retained; their
received member types and bytes are unknown. No serialization defect or causal explanation was
established. Reducing irrelevant grammar may help, but authored CI fixtures do not prove future
provider compliance or content quality. M3's auto-choice carrier remains advisory, not forced
schema decoding. Claims4/hp4, every recipe/source/asset/explanation identity, stable roles,
generation, token/request/quota/brake bounds and max-four/one-repair limits remain unchanged.
Historical v1–v9 jobs, attempts, issues and protected request bytes remain immutable. This source
version supplies no operator profile, rollout, allocation, reservation or permission to call again.

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

## Canonical prose binding projection in v12

Policy `scroll-production.v12` / writer `scroll-writer.v10` narrows only the selected passage
binding's optional `field` to literal `text` through the canonical node's `safeExtend`. Omission
retains the compiler's canonical prose default. Paragraph and callout span arrays project to that
field; `data.spans`, `data.spans.0.text`, `data.text` and other JSON/schema paths are not prose
binding fields. The full core DSL remains unchanged. Header/heading/block nodes are reused
exactly; the selected format uses whole-block bindings for diagrams/comparisons. Empirical numbers
still require exact canonical support, otherwise the explanation must remain qualitative.

Instructions distinguish the projected field from the input JSON, require exact unique
single-sentence anchors from the writer's own original prose and actual supplied claim IDs,
and show passage/default/explicit-text, header and heading syntax in the fictional example.
The example remains nonpublishable under real offered evidence. No quote transcription,
copy-nine evasion, source/honesty/numeric/a11y/reading-bound or admission relaxation is added.

The real v11 job was rejected after three settled calls. Its bounded metadata contains six
`binding_field_unknown` and one `copied_passage` entry at masked primary paths; repair records
the fixed `unreadable` root category with `REPLY_TOOL_JSON_INVALID`. Failed bodies were discarded.
These categories do not reveal the actual fields, received types, prose or malformed tool JSON.
This correction follows the canonical projection's source contract, not reconstructed answers.

Claims4/hp4, writer hp5 JSON-string carrier, all recipes/identities, stable roles, generation,
4000/12000 output ceilings, 100000-byte request cap, tokens, brakes and one repair/max-four
accounting remain unchanged. The new version is source lineage, not another allocation or paid
retry grant. Existing historical rows/requests/SQL remain immutable. Actions use authored
default/explicit-text positives and invented-path negatives through canonical compilation and
native HTTP/PostgreSQL repair/replay; these fixtures do not prove provider success. No operator
profile, ready config, deployment, live query, reservation or model call is authorized here.

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

## Cell-free canonical flow selection in v13

Policy `scroll-production.v13` and writer/provenance `scroll-writer.v11` select only canonical
`flow-lr` diagrams with canonical nodes whose optional `cell` property is omitted. The selected
schema still requires a toggle with two to four meaningful frames, all canonical arrays, accessible
labels and fallback text. It reuses canonical node fields and bounds; valid grids and every other
layout remain available to other producers. The shared DSL, compiler, semantic/admission checks,
copy-nine, support/honesty/numeric/reading rules and comparative mode are unchanged.

A real v12 job ended rejected with no asset after three settled requests. Its bounded safe metadata
records only `unreadable` at the primary root and one `diagram_cells_invalid` at a masked repair
path. Both failed bodies are absent. That rule covers missing/duplicate grid cells and cells on a
non-grid layout; the retained evidence cannot distinguish these cases or reconstruct the discarded
primary JSON. Selecting a cell-free canonical flow removes all three combinations from this writer's
structural grammar. It does not prove the historical offending value, repair the primary carrier,
or establish future provider/editorial success.

Claims4/hp4, writer carrier hp5, topics/assets/explanation units, roles and generation remain stable.
All request/output/token/quota/brake/max-four/one-repair limits and historical financial state remain
unchanged. The real v12 stop-on-first-failure remains in force. This source version authorizes no
operator change, reservation, provider retry, new job or deployment. Authored Actions fixtures cover
the three invalid cell cases, canonical grids outside this selection, actual HTTP/PG bounded repair
and policy12 historical-byte preservation. They are not generated library content.
